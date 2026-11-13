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

export function registerTools(server: McpServer, runner: Runner, config: OrchestraConfig, user: UserConfig): void {
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

  // 7. notify_test — проверка канала уведомлений (вебхук → Telegram)
  server.registerTool(
    "notify_test",
    {
      title: "Тест уведомлений",
      description:
        "Шлёт тестовое сообщение в ваш Telegram (chat id задан при настройке; переопределяется в аккаунте). " +
        "Проверьте notify_test после настройки NOTIFY_WEBHOOK_URL/chat id.",
      inputSchema: accountParam,
    },
    async (args) => {
      try {
        const acc = findUserAccount(config, user, args.account);
        const chatId = acc.notifyChatId ?? user.chatId;
        if (chatId === undefined) {
          return asError("notify_test: chat id не задан — укажите chatId у вашего пользователя (ORCHESTRA_USERS) или notifyChatId у аккаунта");
        }
        const r = await notify(chatId, `🔔 zcode-orchestra: тест уведомлений (юзер ${user.name}, акк ${acc.name})`);
        return asText(r.ok ? { ok: true, chatId } : r);
      } catch (e) {
        return asError(`notify_test: ${errMsg(e)}`);
      }
    },
  );
}
