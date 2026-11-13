// claim/client.ts — расшифровка кредов, клиент z.ai и claim-пайплайн.
// Форматы enc:v1/enc:v2 и клиентские заголовки — реверс десктоп-клиента 3.18.1,
// проверены живьём tools/claim-probe.mjs (preview/configs/mt/events → code 0).
// Пайплайн клейма: события активации → preview → минт капчи (vendor happy-dom)
// → POST billing/claim с заголовками X-Aliyun-Captcha-Verify-Param/-Region.
import { createHash, createDecipheriv, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import {
  fetchCaptchaConfig,
  mintVerifyParam,
  type CaptchaConfig,
} from "./mint.js";

export const DEFAULT_APP_VERSION = "3.18.1";
const BASE_URL = "https://zcode.z.ai/api/v1";
const HTTP_TIMEOUT_MS = 25_000;

export interface ActivityPlan {
  planId: string;
  name: string;
  priority: number;
  grants: string[];
}

export interface ClaimOutcome {
  ok: boolean;
  action: "status" | "claim" | "mint-only";
  error?: string;
  appVersion: string;
  platform: string;
  captchaConfig?: CaptchaConfig;
  plans?: ActivityPlan[];
  quota?: unknown;
  quotaSource?: "current" | "balance";
  mint?: { certifyId: string; region: string; verifyParam?: string };
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

export interface PipelineOptions {
  action: "status" | "claim" | "mint-only";
  credentialsPath?: string;
  secretFile?: string;
  secretInline?: string;
  planId?: string;
  appVersion: string;
  platform: string;
  lang: string;
  /** минт-параметры: попытки солвера на круг клейма */
  mintAttempts?: number;
  /** попыток POST claim с свежим минтом при 3007 */
  claimAttempts?: number;
  log: (line: string) => void;
}

// ---------- расшифровка (порт tools/claim-probe.mjs) ----------

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decryptEncValue(value: string, secret: string): string {
  let body = value;
  if (body.startsWith("enc:v2:")) {
    const m = body.match(/^enc:v2:(env|os):([0-9a-f]{24}):(.+)$/s);
    if (!m) throw new Error("не удалось разобрать enc:v2 формат");
    if (m[1] === "os") throw new Error("enc:v2:os требует OS keyring — не поддерживается");
    const key = createHash("sha256").update(secret, "utf8").digest();
    const keyid = createHash("sha256").update(key).digest().toString("hex").slice(0, 24);
    if (keyid !== m[2]) throw new Error(`keyid не совпал (файл ${m[2]}, наш ${keyid}) — не тот секрет?`);
    body = m[3] ?? "";
  } else {
    body = body.replace(/^enc:v1:/, "");
  }
  const [nB64 = "", tB64 = "", cB64 = ""] = body.split(".");
  const nonce = b64urlDecode(nB64);
  const tag = b64urlDecode(tB64);
  const ct = b64urlDecode(cB64);
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("nonce/tag длины не 12/16");
  const key = createHash("sha256").update(secret, "utf8").digest();
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** Рекурсивный сбор полей enc:v1:/enc:v2: из credentials.json. */
function collectEncrypted(obj: unknown, path = "", out: Record<string, string> = {}): Record<string, string> {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      collectEncrypted(v, path ? `${path}.${k}` : k, out);
    }
  } else if (typeof obj === "string" && /^enc:v[12]:/.test(obj)) {
    out[path] = obj;
  }
  return out;
}

export interface DecryptedCreds {
  jwt: string;
  jwtField: string;
  plain: Record<string, string>;
}

/** Расшифровка credentials.json: перебирает варианты секрета (raw / без хвостового \n). */
export function decryptCredentials(credentialsPath: string, secretFile?: string, secretInline?: string): DecryptedCreds {
  const credentialsJson: unknown = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const encEntries = collectEncrypted(credentialsJson);
  const secrets: string[] = [];
  if (secretInline) secrets.push(secretInline);
  if (secretFile) {
    if (!existsSync(secretFile)) throw new Error(`secret-файл не найден: ${secretFile}`);
    const raw = readFileSync(secretFile, "utf8");
    secrets.push(raw, raw.replace(/\r?\n$/, ""));
  }
  if (secrets.length === 0) {
    throw new Error("не задан секрет (ZCODE_CREDENTIAL_SECRET_FILE / --secret-file / --secret)");
  }
  const plain: Record<string, string> = {};
  let jwt = "";
  let jwtField = "";
  for (const [field, enc] of Object.entries(encEntries)) {
    for (const secret of secrets) {
      try {
        const value = decryptEncValue(enc, secret);
        plain[field] = value;
        if (!jwt && /zcodejwttoken/i.test(field)) {
          jwt = value;
          jwtField = field;
        }
        break;
      } catch {
        // не тот секрет / не тот формат — пробуем следующий вариант
      }
    }
  }
  if (!jwt) throw new Error("не удалось расшифровать zcodejwttoken ни одним вариантом секрета");
  return { jwt, jwtField, plain };
}

// ---------- HTTP-клиент (мимикрия под официальный клиент) ----------

function deviceMidFor(credentialsPath: string | undefined): string {
  if (!credentialsPath) return "";
  try {
    const telePath = join(dirname(credentialsPath), "telemetry-state.json");
    if (!existsSync(telePath)) return "";
    const parsed = JSON.parse(readFileSync(telePath, "utf8")) as { deviceMid?: unknown };
    return typeof parsed.deviceMid === "string" ? parsed.deviceMid : "";
  } catch {
    return "";
  }
}

function jwtUserId(jwt: string): string {
  try {
    const payloadB64 = jwt.split(".")[1] ?? "";
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const k of ["user_id", "sub"]) {
      const v = payload[k];
      if (typeof v === "string" && v !== "") return v;
    }
  } catch {
    // не JWT-пейлоад — не критично
  }
  return "";
}

export function clientHeaders(jwt: string | null, opts: { appVersion: string; platform: string; lang: string; deviceMid?: string }): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": `ZCode/${opts.appVersion}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": opts.appVersion,
    "X-Platform": opts.platform,
    "X-Release-Channel": "1",
    "X-Client-Language": opts.lang,
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "X-Os-Category": process.platform,
    "x-request-id": randomUUID(),
    "Content-Type": "application/json",
  };
  if (opts.deviceMid) h["X-Device-Mid"] = opts.deviceMid;
  if (jwt) h["Authorization"] = `Bearer ${jwt}`;
  return h;
}

interface ZaiResponse {
  status: number;
  json: unknown | null;
  text: string;
}

async function zaiRequest(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<ZaiResponse> {
  const resp = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // не JSON — оставляем raw
  }
  return { status: resp.status, json, text };
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

// ---------- шаги пайплайна ----------

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

async function reportActivationEvents(
  jwt: string,
  headers: Record<string, string>,
  opts: { appVersion: string; deviceMid: string; lang: string },
  log: (line: string) => void,
): Promise<void> {
  const userId = jwtUserId(jwt);
  for (const element of ["app_launch", "app_daily_active"]) {
    const payload = {
      event_id: randomUUID(),
      client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      client_language: opts.lang,
      element_name: element,
      event_region: "app",
      event_type: "view",
      event_text: "",
      event_extra_detail: {},
      user_id: userId,
      screen_resolution: "2560x1440",
      app_version: opts.appVersion,
      device_os_category: process.platform,
      device_os_version: os.release(),
      device_mid: opts.deviceMid,
      mac_id: "",
      marketing_params: "{}",
    };
    try {
      const r = await zaiRequest("POST", `${BASE_URL}/event/report`, headers, payload);
      log(`[events] ${element}: HTTP ${r.status}, code ${jsonInt(r.json, ["code"]) ?? "?"}`);
    } catch (e) {
      log(`[events] ${element}: ${e instanceof Error ? e.message : String(e)} (не критично)`);
    }
  }
}

async function fetchQuota(
  headers: Record<string, string>,
  appVersion: string,
): Promise<{ quota: unknown; source: "current" | "balance" } | null> {
  for (const source of ["current", "balance"] as const) {
    try {
      const r = await zaiRequest("GET", `${BASE_URL}/zcode-plan/billing/${source}?app_version=${encodeURIComponent(appVersion)}`, headers);
      if (r.status === 200 && jsonInt(r.json, ["code"]) === 0) return { quota: r.json, source };
    } catch {
      // пробуем следующий источник
    }
  }
  return null;
}

interface ClaimAttempt {
  code?: number;
  message: string;
  data: unknown;
  raw: string;
  status: number;
}

async function postClaim(
  jwt: string,
  headers: Record<string, string>,
  planId: string,
  mint: { verifyParam: string; region: string },
): Promise<ClaimAttempt> {
  const claimHeaders = {
    ...headers,
    "x-aliyun-captcha-verify-param": mint.verifyParam,
    "x-aliyun-captcha-verify-region": mint.region,
  };
  const r = await zaiRequest("POST", `${BASE_URL}/zcode-plan/billing/claim`, claimHeaders, { plan_id: planId });
  return {
    status: r.status,
    code: jsonInt(r.json, ["code"]),
    message: jsonStr(r.json, ["msg", "message"]),
    data: jsonPath(r.json, ["data"]),
    raw: r.text,
  };
}

// ---------- пайплайн ----------

export async function runPipeline(opts: PipelineOptions): Promise<ClaimOutcome> {
  const { action, log } = opts;
  const base: ClaimOutcome = { ok: false, action, appVersion: opts.appVersion, platform: opts.platform };

  if (action === "mint-only") {
    // без кредов: только конфиг + минт (локальный смоук вендоред-стека)
    const cfg = await fetchCaptchaConfig(opts.appVersion, opts.platform);
    log(`[captcha] конфиг: prefix=${cfg.prefix} scene=${cfg.sceneId} region=${cfg.region} enabled=${cfg.enabled}`);
    if (!cfg.enabled) return { ...base, error: "капча выключена в client/configs" };
    const mint = await mintVerifyParam(cfg, { attempts: opts.mintAttempts ?? 2, log });
    return { ...base, ok: true, captchaConfig: cfg, mint: { ...mint, verifyParam: mint.verifyParam } };
  }

  if (!opts.credentialsPath) return { ...base, error: "не указан --credentials" };

  let jwt: string;
  let jwtField = "";
  let deviceMid = "";
  try {
    const creds = decryptCredentials(opts.credentialsPath, opts.secretFile, opts.secretInline);
    jwt = creds.jwt;
    jwtField = creds.jwtField;
    deviceMid = deviceMidFor(opts.credentialsPath);
    log(`[creds] расшифрован ${jwtField} (JWT ${jwt.length} симв.), deviceMid=${deviceMid ? "есть" : "нет"}`);
  } catch (e) {
    return { ...base, error: `креды: ${e instanceof Error ? e.message : String(e)}` };
  }

  const headers = clientHeaders(jwt, { appVersion: opts.appVersion, platform: opts.platform, lang: opts.lang, deviceMid });

  // 1. конфиг капчи (публичный, до любых авторизованных вызовов — как настоящий клиент)
  const captchaConfig = await fetchCaptchaConfig(opts.appVersion, opts.platform);
  log(`[captcha] конфиг: prefix=${captchaConfig.prefix} scene=${captchaConfig.sceneId} region=${captchaConfig.region} enabled=${captchaConfig.enabled}`);

  // 2. события активации (триггерят выдачу Start Plan) — только в claim-режиме
  if (action === "claim") {
    await reportActivationEvents(jwt, headers, { appVersion: opts.appVersion, deviceMid, lang: opts.lang }, log);
  }

  // 3. preview — список клеймящихся активностей
  let plans: ActivityPlan[] = [];
  try {
    const r = await zaiRequest(
      "GET",
      `${BASE_URL}/zcode-plan/billing/preview?app_version=${encodeURIComponent(opts.appVersion)}&platform=${encodeURIComponent(opts.platform)}`,
      headers,
    );
    const code = jsonInt(r.json, ["code"]);
    if (r.status === 401 || r.status === 403 || code === 401) {
      return { ...base, error: `preview: HTTP ${r.status} — JWT недействителен или истёк` };
    }
    if (r.status !== 200 || (code !== undefined && code !== 0)) {
      return { ...base, error: `preview: HTTP ${r.status}, код ${code}: ${jsonStr(r.json, ["msg", "message"]) || "-"}` };
    }
    plans = parsePlans(r.json);
    log(`[preview] активностей: ${plans.length}${plans.map((p) => ` | ${p.planId} «${p.name}»`).join("")}`);
  } catch (e) {
    return { ...base, error: `preview: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 4. клейм
  let claim: ClaimOutcome["claim"];
  if (action === "claim") {
    const target = opts.planId
      ? plans.find((p) => p.planId === opts.planId)
      : plans[0];
    if (!target && opts.planId) {
      return { ...base, ok: false, plans, error: `план «${opts.planId}» не найден в preview` };
    }
    if (!target) {
      claim = { planId: "", result: "denied", message: "нет доступных активностей (preview пуст)" };
    } else {
      const mintAttempts = opts.mintAttempts ?? 3;
      const claimAttempts = opts.claimAttempts ?? 2;
      let lastAttempt: ClaimAttempt | undefined;
      for (let round = 1; round <= claimAttempts; round++) {
        try {
          const mint = await mintVerifyParam(captchaConfig, { attempts: mintAttempts, log });
          log(`[claim] POST billing/claim {plan_id: ${target.planId}} — круг ${round}/${claimAttempts}`);
          lastAttempt = await postClaim(jwt, headers, target.planId, mint);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // фатальная ошибка минта (IP-блок/F008) — ретрай не лечит
          if (/IP-блок|F008/.test(msg) || round === claimAttempts) {
            return { ...base, plans, captchaConfig, error: `минт: ${msg}` };
          }
          continue;
        }
        if (lastAttempt.code === 0) break;
        if (lastAttempt.code === 3007 && round < claimAttempts) {
          log(`[claim] 3007 (капча отклонена) — свежий минт и повтор`);
          continue;
        }
        break;
      }
      const a = lastAttempt;
      if (!a) {
        claim = { planId: target.planId, planName: target.name, result: "error", message: "попытки клейма не выполнились" };
      } else if (a.code === 0) {
        const planInfo = a.data && typeof a.data === "object" ? (a.data as Record<string, unknown>).plan : undefined;
        claim = {
          planId: target.planId,
          planName: target.name,
          result: "claimed",
          code: 0,
          startsAt: jsonInt(planInfo, ["starts_at"]),
          endsAt: jsonInt(planInfo, ["ends_at"]),
          status: jsonStr(planInfo, ["status"]),
        };
        log(`[claim] УСПЕХ: ${JSON.stringify(planInfo ?? {})}`);
      } else {
        const friendly = explainClaimCode(a.code);
        claim = {
          planId: target.planId,
          planName: target.name,
          result: a.code === 3007 ? "error" : "denied",
          code: a.code,
          message: friendly ? `${friendly} (код ${a.code}: ${a.message || "-"})` : `код ${a.code}: ${a.message || "-"}`,
        };
        log(`[claim] отказ/ошибка: ${claim.message}`);
      }
    }
  }

  // 5. квота
  const quota = await fetchQuota(headers, opts.appVersion);
  if (quota) log(`[quota] billing/${quota.source}: ок`);

  return {
    ok: claim ? claim.result === "claimed" : true,
    action,
    appVersion: opts.appVersion,
    platform: opts.platform,
    captchaConfig,
    plans,
    quota: quota?.quota,
    quotaSource: quota?.source,
    claim,
  };
}

/** Человекочитаемая расшифровка кодов клейма (реверс + живые пробы). */
function explainClaimCode(code: number | undefined): string {
  switch (code) {
    case 1005: return "суточный слот исчерпан — уже клеймилось сегодня (NextAt = ends_at плана)";
    case 1002: return "кампания завершена";
    case 3006: return "модель не разрешена на этом аккаунте";
    case 3007: return "капча не прошла верификацию";
    case 3001: return "отсутствует параметр верификации";
    case 3101: return "для Start Plan reset недоступен";
    default: return undefined as unknown as string;
  }
}
