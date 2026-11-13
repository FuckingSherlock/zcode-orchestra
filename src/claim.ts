// claim.ts — MCP-обёртка над claim-cli: спавнит отдельный node-процесс
// (dist/claim-cli.js), который расшифровывает креды, минтит Aliyun-капчу
// вендоред happy-dom-солвером (src/vendor/captcha-happy.ts, TriDefender,
// CC BY-NC-SA — см. NOTICE.md) и постит billing/claim. Отдельный процесс:
// минт не делит heap с сервером (512МБ своих против серверного кэпа 224МБ)
// и не роняет сервер на экзотике guest-DOM.
// Контракт: stdout child'а — одна строка JSON ClaimOutcome; прогресс — stderr.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAccount, type OrchestraConfig } from "./config.js";

const claimCliPath = join(dirname(fileURLToPath(import.meta.url)), "claim-cli.js");

const CLAIM_TIMEOUT_MS = 240_000; // минт-лесенка (3×30с) × 2 круга + сеть — с запасом
const RAW_SNIPPET = 1600; // сырой квота-JSON в тексте результата обрезаем

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Outcome {
  ok?: boolean;
  action?: string;
  error?: string;
  appVersion?: string;
  platform?: string;
  plans?: Array<{ planId: string; name: string; priority: number; grants: string[] }>;
  quota?: unknown;
  quotaSource?: string;
  claim?: {
    planId: string;
    planName?: string;
    result: "claimed" | "denied" | "error";
    code?: number;
    message?: string;
    startsAt?: number;
    endsAt?: number;
    status?: string;
  };
}

function formatOutcome(accName: string, outcome: Outcome, stderrTail: string): string {
  const lines: string[] = [`=== claim_credits (${accName}) ===`];
  if (outcome.error) lines.push(`ОШИБКА: ${outcome.error}`);

  const plans = outcome.plans ?? [];
  lines.push(
    plans.length > 0
      ? `Активности (${plans.length}): ${plans
          .map((p) => `${p.name} [${p.planId}] приор. ${p.priority}${p.grants.length > 0 ? `; ${p.grants.join("; ")}` : ""}`)
          .join(" | ")}`
      : "Активности: доступных нет (claimовать нечего)",
  );

  const c = outcome.claim;
  if (c) {
    if (c.result === "claimed") {
      const endsAt = c.endsAt ? new Date(c.endsAt * 1000).toISOString() : "";
      const startsAt = c.startsAt ? new Date(c.startsAt * 1000).toISOString() : "";
      lines.push(
        `Клейм: УСПЕХ — «${c.planName || c.planId}» (${c.planId})` +
          `${c.status ? `, статус ${c.status}` : ""}` +
          `${startsAt ? `, действует с ${startsAt}` : ""}${endsAt ? ` до ${endsAt}` : ""}`,
      );
    } else if (c.result === "denied") {
      lines.push(`Клейм: ОТКАЗ — ${c.message || "(без сообщения)"}`);
    } else {
      lines.push(`Клейм: ОШИБКА — ${c.message || "(без сообщения)"}`);
    }
  }

  if (outcome.quota !== undefined && outcome.quota !== null) {
    const raw = JSON.stringify(outcome.quota);
    lines.push(`Квота (billing/${outcome.quotaSource ?? "current"}): ${raw.length > RAW_SNIPPET ? `${raw.slice(0, RAW_SNIPPET)}…(обрезано)` : raw}`);
  }

  if (!outcome.error && !c && outcome.action !== "status") {
    lines.push("Результат клейма отсутствует в ответе claim-cli — см. логи сервера.");
  }
  if (stderrTail) lines.push(`Лог claim-cli (хвост): ${stderrTail}`);
  return lines.join("\n");
}

/**
 * Полный цикл claim для аккаунта: активация → preview → минт капчи → claim → квота.
 * Возвращает готовый многострочный текст для тулзы claim_credits.
 */
export async function runClaim(config: OrchestraConfig, accountName?: string): Promise<string> {
  const acc = findAccount(config, accountName);
  const credsPath = acc.credentialsFile ?? join(homedir(), ".zcode", "v2", "credentials.json");

  // presence-проверка с дружелюбной подсказкой (child дальше ругнётся детальнее)
  try {
    await readFile(credsPath, "utf8");
  } catch (e) {
    return [
      `=== claim_credits (${acc.name}) ===`,
      `ОШИБКА: credentials.json не найден или не читается: ${credsPath}`,
      `Причина: ${errMsg(e)}`,
      "Аккаунт ещё не залогинен? Внутри контейнера:",
      "  docker compose exec zcode-orchestra zcode login --oauth --no-browser",
      "и откройте ссылку в любом браузере (сначала залогиньтесь на chat.z.ai).",
    ].join("\n");
  }

  const secretFile = process.env.ZCODE_CREDENTIAL_SECRET_FILE ?? "";
  const args = [
    claimCliPath,
    "--credentials",
    credsPath,
    ...(secretFile !== "" ? ["--secret-file", secretFile] : []),
    "--claim",
  ];

  return await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512" },
      timeout: CLAIM_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000); // держим хвост
    });
    child.on("error", (e) => {
      resolve([`=== claim_credits (${acc.name}) ===`, `ОШИБКА: не удалось запустить claim-cli: ${errMsg(e)}`].join("\n"));
    });
    child.on("close", (code) => {
      const trimmed = stdout.trim();
      const parsed: Outcome | null = (() => {
        try {
          // stdout может содержать только финальную JSON-строку — берём последнюю непустую
          const last = trimmed.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
          return JSON.parse(last) as Outcome;
        } catch {
          return null;
        }
      })();
      if (parsed) {
        const stderrTail = stderr.trim().split("\n").slice(-4).join(" ⏎ ");
        resolve(formatOutcome(acc.name, parsed, code === 0 ? "" : `exit ${code ?? "?"}${stderrTail ? `; ${stderrTail}` : ""}`));
      } else {
        resolve(
          [
            `=== claim_credits (${acc.name}) ===`,
            `ОШИБКА: claim-cli не вернул JSON (exit ${code ?? "?"})`,
            stderr.trim() ? `stderr: ${stderr.trim().slice(-1200)}` : `stdout: ${trimmed.slice(0, 1200) || "(пусто)"}`,
          ].join("\n"),
        );
      }
    });
  });
}
