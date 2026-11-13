// claim.ts — ЭКСПЕРИМЕНТАЛЬНЫЙ модуль клейма активностей Z.AI (Start Plan).
// Портировано по референсу https://github.com/genevatrkassulkusc82-collab/zcode-proxy (activity.go/quota.go):
//   детект:  GET  https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=&platform=
//   клейм:   POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim  {"plan_id"} (+ заголовки капчи)
//   активация: POST https://zcode.z.ai/api/v1/event/report (app_launch + app_daily_active)
//   квота:   GET  https://zcode.z.ai/api/v1/zcode-plan/billing/current (фолбэк .../billing/balance)
// Креды: ~/.zcode/v2/credentials.json → ключ "zcodejwttoken". Значения с префиксом "enc:v1:"
// зашифрованы официальным рантаймом — расшифровку НЕ реализуем, отдаём честную ошибку.
// Капча/anti-bot в v1 не автоматизируются: при верификации — инструкция на ручной клейм.
// Секреты (JWT) в результаты не выводятся.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findAccount, type OrchestraConfig } from "./config.js";

const APP_VERSION = "3.11.2"; // fallback версии десктоп-клиента из референса
const BASE_URL = "https://zcode.z.ai/api/v1";
const PREVIEW_URL = `${BASE_URL}/zcode-plan/billing/preview`;
const CLAIM_URL = `${BASE_URL}/zcode-plan/billing/claim`;
const EVENT_REPORT_URL = `${BASE_URL}/event/report`;
const BILLING_CURRENT_URL = `${BASE_URL}/zcode-plan/billing/current`;
const BILLING_BALANCE_URL = `${BASE_URL}/zcode-plan/billing/balance`;
const HTTP_TIMEOUT_MS = 20_000;
const RAW_SNIPPET = 2000; // сырой ответ в тексте ошибки обрезаем до 2000 символов

interface ZaiResponse {
  status: number;
  text: string;
  json: unknown | null;
}

class ClaimHttpError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.raw = raw;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function trimRaw(s: string, max = RAW_SNIPPET): string {
  return s.length > max ? `${s.slice(0, max)}…(обрезано)` : s;
}

function errText(e: unknown): string {
  const msg = errMsg(e);
  const raw = e instanceof ClaimHttpError && e.raw ? `\nсырой ответ: ${trimRaw(e.raw)}` : "";
  return `${msg}${raw}`;
}

function jsonStr(v: unknown, keys: string[]): string {
  if (v === null || typeof v !== "object") return "";
  const obj = v as Record<string, unknown>;
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim() !== "") return val;
  }
  return "";
}

function jsonInt(v: unknown, keys: string[]): number | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string" && val.trim() !== "" && Number.isFinite(Number(val))) return Number(val);
  }
  return undefined;
}

function jsonPath(v: unknown, path: string[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Идентификация клиента как ZCode Desktop (по ZaiClientHeaders из референса) */
function clientHeaders(jwt: string | null): Record<string, string> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const h: Record<string, string> = {
    "User-Agent": `ZCode/${APP_VERSION}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": APP_VERSION,
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Release-Channel": "stable",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": tz,
    "X-Os-Category": process.platform,
    "X-Os-Version": os.release(),
    "x-request-id": randomUUID(),
    "Content-Type": "application/json",
  };
  if (jwt) h["Authorization"] = `Bearer ${jwt}`;
  return h;
}

async function zaiRequest(
  method: "GET" | "POST",
  url: string,
  jwt: string,
  body?: unknown,
): Promise<ZaiResponse> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: clientHeaders(jwt),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`сеть: ${errMsg(e)}`);
  }
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // не JSON — отдаём raw
  }
  return { status: resp.status, text, json };
}

/** deviceMid из telemetry-state.json (рядом с credentials.json); нет файла — null */
async function readDeviceMid(telemetryPath: string): Promise<string> {
  try {
    const raw = await readFile(telemetryPath, "utf8");
    return jsonStr(JSON.parse(raw), ["deviceMid"]);
  } catch {
    return "";
  }
}

/** user_id из payload JWT (без подписи — только для event/report) */
function jwtUserId(jwt: string): string {
  try {
    const payloadB64 = jwt.split(".")[1] ?? "";
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return jsonStr(payload, ["user_id", "sub"]);
  } catch {
    return "";
  }
}

interface ActivityPlan {
  planId: string;
  name: string;
  priority: number;
  grants: string[];
}

function parsePlans(body: unknown): ActivityPlan[] {
  const plansRaw = jsonPath(body, ["data", "plans"]);
  if (!Array.isArray(plansRaw)) return [];
  const out: ActivityPlan[] = [];
  for (const p of plansRaw) {
    const planId = jsonStr(p, ["plan_id", "planId"]);
    if (planId === "") continue;
    const grants: string[] = [];
    const ents = jsonPath(p, ["entitlements"]);
    if (Array.isArray(ents)) {
      for (const e of ents) {
        // оставляем только токен-гранты (meter=model_usage, unit_type=token)
        if (jsonStr(e, ["meter"]) !== "model_usage") continue;
        if (jsonStr(e, ["unit_type", "unitType"]) !== "token") continue;
        const showName = jsonStr(e, ["show_name", "showName"]);
        if (showName === "") continue;
        const units = jsonInt(e, ["grant_units", "grantUnits"]) ?? 0;
        const period = jsonStr(e, ["period"]) || "one_time";
        grants.push(`${showName}: ${units} token (${period})`);
      }
    }
    out.push({
      planId,
      name: jsonStr(p, ["name"]) || planId,
      priority: jsonInt(p, ["priority"]) ?? 0,
      grants,
    });
  }
  out.sort((a, b) => b.priority - a.priority);
  return out;
}

function isCaptchaIssue(code: number | undefined, message: string): boolean {
  // 3007 — капча не пройдена; 3001 — параметр верификации отсутствует
  return code === 3007 || code === 3001 || /captcha|капч|验证|challenge|verify/i.test(message);
}

/**
 * Полный цикл claim для аккаунта: детект → активация → квота → клейм.
 * Возвращает готовый многострочный текст для тулзы claim_credits.
 */
export async function runClaim(config: OrchestraConfig, accountName?: string): Promise<string> {
  const acc = findAccount(config, accountName);
  const sections: string[] = [];

  // ---- 1. Креды ----
  const credsPath = acc.credentialsFile ?? path.join(os.homedir(), ".zcode", "v2", "credentials.json");
  let creds: Record<string, unknown>;
  try {
    const raw = await readFile(credsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") throw new Error("структура файла неожиданная");
    creds = parsed as Record<string, unknown>;
  } catch (e) {
    return [
      `=== claim_credits (${acc.name}) ===`,
      `ОШИБКА: credentials.json не найден или не читается: ${credsPath}`,
      `Причина: ${errMsg(e)}`,
      "Аккаунт ещё не залогинен? Выполните внутри контейнера:",
      "  docker compose exec zcode-orchestra zcode login --oauth --no-browser",
      "и откройте ссылку в любом браузере.",
    ].join("\n");
  }

  const jwt = typeof creds["zcodejwttoken"] === "string" ? creds["zcodejwttoken"] : "";
  if (jwt === "") {
    return [
      `=== claim_credits (${acc.name}) ===`,
      `ОШИБКА: в ${credsPath} нет ключа zcodejwttoken — аккаунт не залогинен.`,
      "Выполните: docker compose exec zcode-orchestra zcode login --oauth --no-browser",
    ].join("\n");
  }
  if (jwt.startsWith("enc:v1:")) {
    // шифрование official runtime'а намеренно не реализуем
    return [
      `=== claim_credits (${acc.name}) ===`,
      "ОШИБКА: credentials encrypted, claim недоступен, используйте открытое хранилище / выполните claim вручную",
      `(файл ${credsPath} зашифрован официальным рантаймом: значения в формате enc:v1:...)`,
      "Инструкция: откройте браузер z.ai → страница активностей и заберите кредиты вручную.",
    ].join("\n");
  }
  sections.push(`Креды: JWT найден (длина ${jwt.length}), файл ${credsPath}`);

  const deviceMid = await readDeviceMid(path.join(path.dirname(credsPath), "telemetry-state.json"));
  const userId = jwtUserId(jwt);

  // ---- 2. Детект активностей (billing/preview) ----
  let plans: ActivityPlan[] = [];
  try {
    const r = await zaiRequest("GET", `${PREVIEW_URL}?app_version=${APP_VERSION}&platform=${process.platform}-${process.arch}`, jwt);
    const code = jsonInt(r.json, ["code"]);
    if (r.status === 401 || r.status === 403 || code === 401) {
      throw new ClaimHttpError(`детект: HTTP ${r.status} — JWT недействителен или истёк`, r.text);
    }
    if (r.status !== 200 || (code !== undefined && code !== 0)) {
      throw new ClaimHttpError(
        `детект: HTTP ${r.status}, код ${code}, сообщение: ${jsonStr(r.json, ["msg", "message"]) || "-"}`,
        r.text,
      );
    }
    plans = parsePlans(r.json);
    sections.push(
      plans.length > 0
        ? `Детект: найдено активностей ${plans.length}: ${plans
            .map((p) => `${p.name} [${p.planId}] приоритет ${p.priority}${p.grants.length > 0 ? `; ${p.grants.join("; ")}` : ""}`)
            .join(" | ")}`
        : "Детект: доступных активностей нет (claimовать нечего)",
    );
  } catch (e) {
    sections.push(`Детект: ОШИБКА — ${errText(e)}`);
  }

  // ---- 3. Активация (event/report ×2) — триггерит выдачу Start Plan ----
  if (userId !== "") {
    const results: string[] = [];
    for (const element of ["app_launch", "app_daily_active"]) {
      try {
        const payload = {
          event_id: randomUUID(),
          client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          client_language: "zh-CN",
          element_name: element,
          event_region: "app",
          event_type: "view",
          event_text: "",
          event_extra_detail: {},
          user_id: userId,
          screen_resolution: "2560x1440",
          app_version: APP_VERSION,
          device_os_category: process.platform,
          device_os_version: os.release(),
          device_mid: deviceMid,
          mac_id: "",
          marketing_params: "{}",
        };
        const r = await zaiRequest("POST", EVENT_REPORT_URL, jwt, payload);
        const code = jsonInt(r.json, ["code"]);
        if (r.status >= 400 || (code !== undefined && code !== 0 && code !== -1)) {
          throw new ClaimHttpError(`HTTP ${r.status}, код ${code}, сообщение: ${jsonStr(r.json, ["msg", "message"]) || "-"}`, r.text);
        }
        results.push(`${element}: ок`);
      } catch (e) {
        results.push(`${element}: ОШИБКА — ${errText(e)}`);
      }
    }
    sections.push(`Активация (event/report): ${results.join(", ")}`);
  } else {
    sections.push("Активация (event/report): пропущена — user_id не извлечён из JWT");
  }

  // ---- 4. Статус квоты (billing/current, фолбэк billing/balance) ----
  try {
    let r = await zaiRequest("GET", `${BILLING_CURRENT_URL}?app_version=${APP_VERSION}`, jwt);
    if (r.status !== 200 || jsonInt(r.json, ["code"]) !== 0) {
      r = await zaiRequest("GET", `${BILLING_BALANCE_URL}?app_version=${APP_VERSION}`, jwt);
    }
    sections.push(`Квота: HTTP ${r.status}\n${trimRaw(r.text)}`);
  } catch (e) {
    sections.push(`Квота: ОШИБКА — ${errText(e)}`);
  }

  // ---- 5. Клейм (billing/claim) ----
  if (plans.length === 0 || plans[0] === undefined) {
    sections.push("Клейм: пропущен — нет доступных активностей");
  } else {
    const plan = plans[0]; // parsePlans отсортировал по priority desc
    try {
      const r = await zaiRequest("POST", CLAIM_URL, jwt, { plan_id: plan.planId });
      let code = jsonInt(r.json, ["code"]);
      if (code === undefined && r.status >= 400) code = r.status;
      const message = jsonStr(r.json, ["msg", "message"]);
      if (code === undefined || code === 0) {
        const planInfo = jsonPath(r.json, ["data", "plan"]);
        const endsAt = jsonInt(planInfo, ["ends_at"]);
        const status = jsonStr(planInfo, ["status"]);
        sections.push(
          `Клейм: УСПЕХ — план «${plan.name}» (${plan.planId})${status ? `, статус ${status}` : ""}${
            endsAt ? `, действует до ${new Date(endsAt * 1000).toISOString()}` : ""
          }`,
        );
      } else if (isCaptchaIssue(code, message)) {
        sections.push(
          `Клейм: требуется капча/верификация (код ${code}: ${message || "-"}). ` +
            "Капча в v1 не автоматизирована — пройдите вручную в браузере z.ai → страница активностей.",
        );
      } else {
        sections.push(`Клейм: отказ — код ${code}: ${message || "-"}\n${trimRaw(r.text)}`);
      }
    } catch (e) {
      sections.push(`Клейм: ОШИБКА — ${errText(e)}`);
    }
  }

  return [
    `=== claim_credits (${acc.name}) ===`,
    ...sections,
    "Примечание: модуль experimental; клейм с капчей выполняйте вручную в браузере z.ai → страница активностей.",
  ].join("\n");
}
