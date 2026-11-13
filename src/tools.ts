// MCP-тулзы оркестратора. Все результаты — JSON в text-content;
// ошибки — text-content с isError:true (чтобы оркестратор мог их прочитать).
// Скоупинг: каждый вызов выполняется от имени пользователя MCP (bearer → user);
// пользователь видит и адресует только свои аккаунты (user.accounts).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { findUserAccount, type OrchestraConfig, type UserConfig } from "./config.js";
import { Runner } from "./runner.js";
import { runClaim } from "./claim.js";
import { notify } from "./notify.js";
import type { AccountManager } from "./accounts.js";
import type { NotifyBinder } from "./notify-bind.js";

const WAIT_TIMEOUT_MS = 30 * 60 * 1000; // wait=true ждёт завершения не дольше 30 минут
const STATUS_LOG_TAIL = 1000;

function asText(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function asError(msg: string): CallToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Скоуп аккаунтов пользователя (для фильтрации списков задач). */
function allowedAccounts(config: OrchestraConfig, user: UserConfig): Set<string> {
  return new Set(user.accounts.includes("*") ? config.accounts.map((a) => a.name) : user.accounts);
}

export function registerTools(server: McpServer, runner: Runner, config: OrchestraConfig, user: UserConfig, accounts: AccountManager, binder: NotifyBinder): void {
  const accountParam = {
    account: z.string().optional().describe("Имя аккаунта (из доступных вам); по умолчанию main или первый ваш"),
  };

  // 1. zcode_agent — постановка брифованной сессии в очередь
  server.registerTool(
    "zcode_agent",
    {
      title: "Запуск брифованной сессии zcode",
      description:
        "Ставит в очередь отдельную сессию `zcode -p <brief> --output-format json` (свой workdir, своя сессия в session DB). " +
        "wait=false (по умолчанию) — мгновенно возвращает jobId, статус проверяйте zcode_job_status; " +
        "wait=true — ждёт завершения до 30 минут и возвращает финальный результат. " +
        "workdir относительный резолвится от корня воркспейсов; account по умолчанию main. " +
        "Для продолжения сессии передайте resume=<session_id из прошлого вызова>.",
      inputSchema: {
      brief: z.string().min(1).describe("Бриф для агента: полная постановка задачи одним сообщением"),
      workdir: z.string().optional().describe("Рабочая папка сессии (абсолютная или относительно корня воркспейсов)"),
      model: z.string().optional().describe("Модель, напр. account:zai-start-plan/GLM-5.3-Flash; по умолчанию — модель аккаунта"),
      effort: z.string().optional().describe("Уровень усилий для zcode --effort (напр. low|medium|high)"),
      resume: z.string().optional().describe("session_id предыдущей сессии для продолжения (--resume)"),
      account: accountParam.account,
      wait: z.boolean().optional().describe("true — дождаться завершения (до 30 минут); по умолчанию false"),
    },
    },
    async (args) => {
      try {
        findUserAccount(config, user, args.account); // ранняя проверка скоупа (submit сам резолвит по имени)
        const { jobId, position } = runner.submit({
          brief: args.brief,
          workdir: args.workdir,
          model: args.model,
          effort: args.effort,
          resume: args.resume,
          account: args.account,
        });
        if (args.wait === true) {
          const rec = await runner.waitFor(jobId, WAIT_TIMEOUT_MS);
          const stillRunning = rec.status === "queued" || rec.status === "running";
          return asText({
            jobId,
            status: rec.status,
            exitCode: rec.exitCode,
            result: rec.result,
            session_id: rec.sessionId,
            usage: rec.usage,
            error: rec.error,
            note: stillRunning ? "истёк таймаут ожидания 30 минут; задача ещё выполняется — опрашивайте zcode_job_status" : undefined,
          });
        }
        return asText({ jobId, status: "queued", position });
      } catch (e) {
        return asError(`zcode_agent: ${errMsg(e)}`);
      }
    },
  );

  // 2. zcode_job_status — статус одной задачи
  server.registerTool(
    "zcode_job_status",
    {
      title: "Статус задачи",
      description:
        "Возвращает статус задачи: status, exitCode, result (до 4000 символов), usage, session_id (для resume), " +
        "error и последние 1000 символов журнала (logTail).",
      inputSchema: {
        jobId: z.string().min(1).describe("Идентификатор задачи из zcode_agent"),
      },
    },
    async (args) => {
      try {
        const info = await runner.status(args.jobId, STATUS_LOG_TAIL);
        if (!info) return asError(`zcode_job_status: задача ${args.jobId} не найдена`);
        if (!allowedAccounts(config, user).has(info.record.account)) {
          return asError(`zcode_job_status: задача ${args.jobId} вам недоступна (чужой аккаунт)`);
        }
        const r = info.record;
        return asText({
          jobId: r.jobId,
          status: r.status,
          exitCode: r.exitCode,
          result: r.result,
          usage: r.usage,
          session_id: r.sessionId,
          error: r.error,
          logTail: info.logTail,
          workdir: r.workdir,
          account: r.account,
          model: r.model,
          createdAt: r.createdAt,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
        });
      } catch (e) {
        return asError(`zcode_job_status: ${errMsg(e)}`);
      }
    },
  );

  // 3. zcode_jobs — список последних задач (только свои аккаунты)
  server.registerTool(
    "zcode_jobs",
    {
      title: "Список задач",
      description: "Последние 20 задач по ВАШИМ аккаунтам, свежие первыми.",
    },
    async () => {
      try {
        const allowed = allowedAccounts(config, user);
        const jobs = runner
          .list(60)
          .filter((r) => allowed.has(r.account))
          .slice(0, 20)
          .map((r) => ({
            jobId: r.jobId,
            status: r.status,
            brief: r.brief,
            account: r.account,
            model: r.model,
            createdAt: r.createdAt,
            finishedAt: r.finishedAt,
            exitCode: r.exitCode,
          }));
        return asText({ count: jobs.length, jobs });
      } catch (e) {
        return asError(`zcode_jobs: ${errMsg(e)}`);
      }
    },
  );

  // 4. zcode_job_cancel — отмена задачи
  server.registerTool(
    "zcode_job_cancel",
    {
      title: "Отмена задачи",
      description: "Отменяет задачу: queued снимается с очереди, running получает SIGTERM (через 10 секунд — SIGKILL).",
      inputSchema: {
        jobId: z.string().min(1).describe("Идентификатор задачи"),
      },
    },
    async (args) => {
      try {
        const info = await runner.status(args.jobId, 0);
        if (!info) return asError(`zcode_job_cancel: задача ${args.jobId} не найдена`);
        if (!allowedAccounts(config, user).has(info.record.account)) {
          return asError(`zcode_job_cancel: задача ${args.jobId} вам недоступна (чужой аккаунт)`);
        }
        const rec = await runner.cancel(args.jobId);
        if (!rec) return asError(`zcode_job_cancel: задача ${args.jobId} не найдена`);
        return asText({ jobId: rec.jobId, status: rec.status, error: rec.error });
      } catch (e) {
        return asError(`zcode_job_cancel: ${errMsg(e)}`);
      }
    },
  );

  // 5. account_status — состояние аккаунта
  server.registerTool(
    "account_status",
    {
      title: "Статус аккаунта",
      description: "Конфигурация аккаунта (модель, файлы-переопределения), число активных задач и счётчики done/failed.",
      inputSchema: accountParam,
    },
    async (args) => {
      try {
        const acc = findUserAccount(config, user, args.account);
        return asText({
          account: acc.name,
          model: acc.model,
          configuredFiles: { credentialsFile: acc.credentialsFile, providerConfigFile: acc.providerConfigFile },
          activeJobs: runner.activeForAccount(acc.name),
          stats: runner.statsForAccount(acc.name),
        });
      } catch (e) {
        return asError(`account_status: ${errMsg(e)}`);
      }
    },
  );

  // 6. claim_credits — клейм кредитов Z.AI
  server.registerTool(
    "claim_credits",
    {
      title: "Клейм кредитов Z.AI",
      description:
        "Полный цикл клейма бесплатных кредитов Z.AI Start Plan: активация (event/report) → детект активностей " +
        "(billing/preview) → минт Aliyun-капчи (happy-dom, ~5-10с) → billing/claim → квота. " +
        "plan_id не указан — берётся активность с высшим приоритетом.",
      inputSchema: accountParam,
    },
    async (args) => {
      try {
        findUserAccount(config, user, args.account); // ранняя валидация скоупа
        const text = await runClaim(config, user, args.account);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return asError(`claim_credits: ${errMsg(e)}`);
      }
    },
  );

  // 7. notify_code — привязка Telegram по одноразовому коду (основной путь)
  server.registerTool(
    "notify_code",
    {
      title: "Привязка Telegram по коду",
      description:
        "Выдаёт одноразовый код привязки Telegram. Отдайте код пользователю и попросите отправить его боту " +
        "@GlmQuotaBot любым сообщением — chat id привяжется автоматически (свой id узнавать не нужно), " +
        "в Telegram придёт подтверждение ✅. Код живёт 10 минут. Повторный вызов — заменить привязку.",
    },
    async () => {
      try {
        const { code, expiresAtMs } = binder.requestCode(user);
        return asText({
          ok: true,
          code,
          bot: "@GlmQuotaBot",
          expiresInMinutes: 10,
          instructions: `Отправьте боту @GlmQuotaBot сообщение: ${code} (можно одним этим словом). Подтверждение придёт в Telegram.`,
          next: "после подтверждения проверьте notify_test",
          expiresAtIso: new Date(expiresAtMs).toISOString(),
        });
      } catch (e) {
        return asError(`notify_code: ${errMsg(e)}`);
      }
    },
  );

  // 8. notify_setup — ручная привязка (если chat id известен) / переопределение на аккаунт
  server.registerTool(
    "notify_setup",
    {
      title: "Настройка уведомлений (вручную)",
      description:
        "Задать Telegram chat id вручную. Обычно НЕ нужно: используйте notify_code — юзер просто отправит " +
        "код боту @GlmQuotaBot, и chat id привяжется сам. Годится для переопределения chat id одного аккаунта (account=...).",
      inputSchema: {
        chatId: z.number().int().positive().describe("Telegram chat id (положительное целое)"),
        account: accountParam.account,
      },
    },
    async (args) => {
      try {
        if (args.account !== undefined) findUserAccount(config, user, args.account); // скоуп
        const r = accounts.setNotifyChatId(config, user, args.chatId, args.account);
        return asText({ ok: true, setFor: r.target, chatId: args.chatId });
      } catch (e) {
        return asError(`notify_setup: ${errMsg(e)}`);
      }
    },
  );

  // 9. notify_test — проверка канала уведомлений (вебхук → Telegram)
  server.registerTool(
    "notify_test",
    {
      title: "Тест уведомлений",
      description:
        "Шлёт тестовое сообщение в ваш Telegram через Worker-релей. Проверьте после notify_setup.",
      inputSchema: accountParam,
    },
    async (args) => {
      try {
        const acc = findUserAccount(config, user, args.account);
        const chatId = acc.notifyChatId ?? user.chatId;
        if (chatId === undefined) {
          return asError("notify_test: chat id не задан — сначала notify_setup (или chatId в ORCHESTRA_USERS)");
        }
        const r = await notify(chatId, `🔔 zcode-orchestra: тест уведомлений (юзер ${user.name}, акк ${acc.name})`);
        return asText(r.ok ? { ok: true, chatId } : r);
      } catch (e) {
        return asError(`notify_test: ${errMsg(e)}`);
      }
    },
  );

  // 10. account_add — добавить аккаунт zcode и запустить OAuth-логин
  server.registerTool(
    "account_add",
    {
      title: "Добавить аккаунт zcode",
      description:
        "Создаёт аккаунт и запускает OAuth-авторизацию z.ai: вернёт ссылку — отдайте её пользователю. " +
        "Инструкция пользователю: сначала залогиниться на chat.z.ai в браузере, затем ОТКРЫТЬ ССЫЛКУ СРАЗУ " +
        "(она одноразовая и быстро протухает) и подтвердить доступ. После этого проверьте account_login_status.",
      inputSchema: {
        name: z.string().min(1).max(32).describe("Имя нового аккаунта (латиница/цифры/-/_)"),
        model: z.string().optional().describe("Модель по умолчанию, напр. account:zai-start-plan/GLM-5.3-Flash"),
      },
    },
    async (args) => {
      try {
        const r = await accounts.startLogin(config, user, args.name, args.model);
        if (r.alreadyAuthorized) {
          return asText({ ok: true, name: args.name, authorized: true, note: "аккаунт уже авторизован — можно пользоваться" });
        }
        if (!r.url) {
          return asError(`account_add: ссылка не пришла от zcode login за 20с — повторите вызов или проверьте account_login_status (${args.name})`);
        }
        return asText({
          ok: true,
          name: args.name,
          loginUrl: r.url,
          instructions: [
            "1. В браузере: войдите на chat.z.ai (если ещё не залогинены).",
            "2. СРАЗУ откройте loginUrl и подтвердите доступ (ссылка одноразовая).",
            "3. Проверьте результат: account_login_status(name=" + args.name + ").",
          ].join(" "),
        });
      } catch (e) {
        return asError(`account_add: ${errMsg(e)}`);
      }
    },
  );

  // 11. account_login_status — статус авторизации аккаунта
  server.registerTool(
    "account_login_status",
    {
      title: "Статус авторизации аккаунта",
      description: "Авторизован ли аккаунт zcode (credentials на месте) и крутится ли сейчас OAuth-логин.",
      inputSchema: {
        name: z.string().min(1).describe("Имя аккаунта"),
      },
    },
    async (args) => {
      try {
        if (!config.accounts.some((a) => a.name === args.name)) {
          return asError(`account_login_status: аккаунт «${args.name}» не найден`);
        }
        return asText(accounts.loginSnapshot(config, args.name));
      } catch (e) {
        return asError(`account_login_status: ${errMsg(e)}`);
      }
    },
  );

  // 12. account_list — список аккаунтов пользователя
  server.registerTool(
    "account_list",
    {
      title: "Список аккаунтов",
      description: "Ваши аккаунты zcode: имя, модель, авторизован ли, активные задачи.",
    },
    async () => {
      try {
        const allowed = allowedAccounts(config, user);
        const list = config.accounts
          .filter((a) => allowed.has(a.name))
          .map((a) => ({
            name: a.name,
            model: a.model,
            authorized: accounts.authorized(config, a.name),
            notifyChatId: a.notifyChatId ?? user.chatId,
            activeJobs: runner.activeForAccount(a.name),
          }));
        return asText({ count: list.length, accounts: list });
      } catch (e) {
        return asError(`account_list: ${errMsg(e)}`);
      }
    },
  );

  // 13. account_remove — удалить рантаймный аккаунт
  server.registerTool(
    "account_remove",
    {
      title: "Удалить аккаунт zcode",
      description:
        "Удаляет аккаунт (созданный через account_add): OAuth-креды, директорию, запись в реестре, claim-state. " +
        "Аккаунты из статического конфига (ORCHESTRA_ACCOUNTS) так не удаляются.",
      inputSchema: {
        name: z.string().min(1).describe("Имя аккаунта"),
      },
    },
    async (args) => {
      try {
        accounts.removeAccount(config, user, args.name);
        return asText({ ok: true, name: args.name, removed: true });
      } catch (e) {
        return asError(`account_remove: ${errMsg(e)}`);
      }
    },
  );
}
