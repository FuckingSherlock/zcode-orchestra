// claim.ts — обёртка над claim-cli (standalone child-процесс):
//   runClaimJson()  — спавн + парсинг JSON-результата (используют MCP-тулза и планировщик)
//   runClaim()      — то же + человекочитаемый текст для claim_credits
// Child расшифровывает креды, минтит Aliyun-капчу вендоред happy-dom-солвером
// (src/vendor/captcha-happy.ts, TriDefender, CC BY-NC-SA — см. NOTICE.md) и постит
// billing/claim. Отдельный процесс: минт не делит heap с сервером (512МБ своих
// против серверного кэпа 224МБ) и не роняет сервер на экзотике guest-DOM.
// Контракт: stdout child'а — одна строка JSON ClaimOutcome; прогресс — stderr.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAccount, findUserAccount, type OrchestraConfig, type UserConfig } from "./config.js";
import type { ClaimOutcome } from "./claim/client.js";

const claimCliPath = join(dirname(fileURLToPath(import.meta.url)), "claim-cli.js");

const CLAIM_TIMEOUT_MS = 240_000; // минт-лесенка (3×30с) × 2 круга + сеть — с запасом

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ClaimRunResult {
  outcome: ClaimOutcome | null;
  /** хвост stderr child'а (прогресс/ошибки минта) */
  stderrTail: string;
  exitCode: number | null;
  spawnError?: string;
}

/** Спавн claim-cli и парсинг JSON-результата. planId — конкретный план или undefined (авто). */
export async function runClaimJson(
  config: OrchestraConfig,
  user: UserConfig | undefined,
  accountName: string | undefined,
  planId?: string,
  mode: "claim" | "status" | "discover" | "whoami" = "claim",
): Promise<ClaimRunResult> {
  const acc = user ? findUserAccount(config, user, accountName) : findAccount(config, accountName);
  const credsPath = acc.credentialsFile ?? join(homedir(), ".zcode", "v2", "credentials.json");
  const secretFile = process.env.ZCODE_CREDENTIAL_SECRET_FILE ?? "";
  const args = [
    claimCliPath,
    "--credentials",
    credsPath,
    ...(secretFile !== "" ? ["--secret-file", secretFile] : []),
    ...(mode === "claim"
      ? ["--claim", ...(planId ? [planId] : [])]
      : mode === "discover"
        ? ["--discover"]
        : mode === "whoami"
          ? ["--whoami"]
          : []),
  ];

  return await new Promise<ClaimRunResult>((resolve) => {
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
      resolve({ outcome: null, stderrTail: stderr.trim(), exitCode: null, spawnError: errMsg(e) });
    });
    child.on("close", (code) => {
      const outcome = (() => {
        try {
          const last = stdout.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
          return JSON.parse(last) as ClaimOutcome;
        } catch {
          return null;
        }
      })();
      const stderrTail = stderr.trim().split("\n").slice(-4).join(" ⏎ ");
      resolve({ outcome, stderrTail, exitCode: code });
    });
  });
}

const RAW_SNIPPET = 1600; // сырой квота-JSON в тексте результата обрезаем

function formatOutcome(accName: string, outcome: ClaimOutcome, stderrTail: string): string {
  const lines: string[] = [`=== claim_credits (${accName}) ===`];
  if (outcome.whoami?.label) {
    lines.push(`Аккаунт z.ai: ${outcome.whoami.label}${outcome.whoami.id ? ` (id ${outcome.whoami.id})` : ""}`);
  }
  if (outcome.error) lines.push(`ОШИБКА: ${outcome.error}`);

  const plans = outcome.plans ?? [];
  lines.push(
    plans.length > 0
      ? `Активности (${plans.length}): ${plans
          .map((p) => `${p.name} [${p.planId}] приор. ${p.priority}${p.grants.length > 0 ? `; ${p.grants.join("; ")}` : ""}`)
          .join(" | ")}`
      : "Активности: доступных нет (claimовать нечего)",
  );

  const campaignIds = outcome.campaignPlanIds ?? [];
  if (campaignIds.length > 0) lines.push(`Кампании (marketing/touch): ${campaignIds.join(", ")}`);

  const c = outcome.claim;
  if (c) {
    if (c.result === "claimed") {
      const endsAt = c.endsAt ? new Date(c.endsAt * 1000).toISOString() : "";
      const startsAt = c.startsAt ? new Date(c.startsAt * 1000).toISOString() : "";
      lines.push(
        `Клейм: УСПЕХ — «${c.planName || c.planId}» (${c.planId})` +
          `${c.status ? `, статус ${c.status}` : ""}` +
          `${startsAt ? `, действует с ${startsAt}` : ""}${endsAt ? ` до ${endsAt}` : ""}` +
          `${c.grants && c.grants.length > 0 ? `\nГранты: ${c.grants.join("; ")}` : ""}`,
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

  if (!outcome.error && !c && outcome.action !== "status" && outcome.action !== "discover") {
    lines.push("Результат клейма отсутствует в ответе claim-cli — см. логи сервера.");
  }
  if (stderrTail) lines.push(`Лог claim-cli (хвост): ${stderrTail}`);
  return lines.join("\n");
}

/**
 * Полный цикл claim для аккаунта: активация → preview → минт капчи → claim → квота.
 * Возвращает готовый многострочный текст для тулзы claim_credits.
 */
export async function runClaim(config: OrchestraConfig, user: UserConfig | undefined, accountName?: string): Promise<string> {
  const acc = user ? findUserAccount(config, user, accountName) : findAccount(config, accountName);
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

  const run = await runClaimJson(config, user, accountName, undefined, "claim");
  if (run.outcome) {
    const errSuffix = run.exitCode !== 0 ? ` (exit ${run.exitCode})` : "";
    return formatOutcome(acc.name, run.outcome, run.exitCode === 0 ? "" : `${errSuffix}${run.stderrTail ? `; ${run.stderrTail}` : ""}`);
  }
  return [
    `=== claim_credits (${acc.name}) ===`,
    `ОШИБКА: claim-cli не вернул JSON (exit ${run.exitCode ?? "?"}${run.spawnError ? `, ${run.spawnError}` : ""})`,
    run.stderrTail ? `stderr: ${run.stderrTail.slice(-1200)}` : "stdout пуст",
  ].join("\n");
}
