#!/usr/bin/env node
/**
 * claim-probe.mjs — зонд клейма ZCode Plan без капчи (как публичная редакция
 * официального клиента: request-security-edition = no-op, заголовки верификации пустые).
 *
 * Шаги:
 *   1. Читает credentials.json, расшифровывает zcodejwttoken (enc:v1, AES-256-GCM).
 *   2. GET  /api/v1/zcode-plan/billing/preview  — список клеймящихся активностей.
 *   3. (опц.) POST /api/v1/zcode-plan/billing/claim {plan_id} — БЕЗ капча-заголовков.
 *   4. (опц.) POST /api/v1/event/report — app_launch + app_daily_active (триггер выдачи).
 *
 * Формат enc:v1 (референс zcode-proxy credential_crypto.go):
 *   "enc:v1:" + b64url(nonce12) + "." + b64url(tag16) + "." + b64url(ciphertext)
 *   ключ = SHA-256(secret); secret = --secret-file/--secret или
 *   fallback "zcode-credential-fallback:{platform}:{home}:{username}".
 *
 * Запуск (контейнер): node tools/claim-probe.mjs \
 *   --credentials /root/.zcode/v2/credentials.json \
 *   --secret-file /run/secrets/zcode-credential-secret [--claim PLAN_ID] [--events]
 */

import { createHash, createDecipheriv, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { basename } from "node:path";

// ---------- аргументы ----------
const args = process.argv.slice(2);
function arg(name, def = undefined) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const has = (name) => args.includes(name);

const credentialsPath = arg("--credentials");
const secretInline = arg("--secret");
const secretFile = arg("--secret-file");
const appVersion = arg("--app-version", "3.18.1");
const claimPlanId = arg("--claim");
const doEvents = has("--events");
const origin = arg("--origin", "https://zcode.z.ai");

if (!credentialsPath || !existsSync(credentialsPath)) {
  console.error("укажи --credentials <путь к credentials.json>");
  process.exit(2);
}

// ---------- enc:v1 дешифровка ----------
function fallbackSecret() {
  const p = osPlatform(); // "win32" | "darwin" | "linux"
  const home = homedir();
  const username = process.env.USERNAME || process.env.USER || process.env.LOGNAME || "unknown";
  return `zcode-credential-fallback:${p}:${home}:${username}`;
}

function resolveSecret() {
  if (secretInline) return secretInline;
  if (secretFile) {
    const raw = readFileSync(secretFile, "utf8");
    // пробуем и как есть, и с обрезанным переводом строки — зависит от того, как создавали
    return raw;
  }
  return fallbackSecret();
}

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decryptEncV1(value, secret) {
  // v1: "enc:v1:nonce.tag.ct" — ключ = sha256(fallback-secret)
  // v2: "enc:v2:<env|os>:<keyid>:<nonce.tag.ct>" — keyid = sha256(key).hex.slice(0,24) (самопроверка),
  //     ключ = sha256(содержимое секрет-файла как есть) для env; os — из keyring (не поддерживаем)
  let body = value;
  if (body.startsWith("enc:v2:")) {
    const m = body.match(/^enc:v2:(env|os):([0-9a-f]{24}):(.+)$/s);
    if (!m) throw new Error("не удалось разобрать enc:v2 формат");
    if (m[1] === "os") throw new Error("enc:v2:os требует OS keyring — не поддерживается зондом");
    const key = createHash("sha256").update(secret, "utf8").digest();
    const keyid = createHash("sha256").update(key).digest().toString("hex").slice(0, 24);
    if (keyid !== m[2]) throw new Error(`keyid не совпал: файл ${m[2]}, наш ${keyid} — не тот секрет?`);
    body = m[3];
  } else {
    body = body.replace(/^enc:v1:/, "");
  }
  const [nB64, tB64, cB64] = body.split(".");
  const nonce = b64urlDecode(nB64);
  const tag = b64urlDecode(tB64);
  const ct = b64urlDecode(cB64);
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("nonce/tag длины не 12/16");
  const key = createHash("sha256").update(secret, "utf8").digest();
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** Рекурсивно ищет строки enc:v1:… в JSON; возвращает {ключ: расшифровка} */
function collectSecrets(obj, path = "", out = {}) {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) collectSecrets(v, path ? `${path}.${k}` : k, out);
  } else if (typeof obj === "string" && /^enc:v[12]:(?:env|os)?:/.test(obj)) {
    out[path] = obj;
  }
  return out;
}

// ---------- клиентские заголовки (мимикрия под официальный клиент) ----------
const credentialsJson = JSON.parse(readFileSync(credentialsPath, "utf8"));
const encEntries = collectSecrets(credentialsJson);

const secretVariants = secretFile || secretInline
  ? [resolveSecret(), resolveSecret().replace(/\r?\n$/, "")]
  : [fallbackSecret()];

let jwt = null;
let jwtKey = null;
outer: for (const [key, enc] of Object.entries(encEntries)) {
  for (const secret of secretVariants) {
    try {
      const plain = decryptEncV1(enc, secret);
      encEntries[key] = plain;
      if (/zcodejwttoken/i.test(key) && !jwt) { jwt = plain; jwtKey = key; }
      break;
    } catch {
      // не тот секрет — пробуем следующий вариант
    }
  }
  if (jwt) break outer;
}

if (!jwt) {
  console.error("не удалось расшифровать zcodejwttoken; найдены зашифрованные поля:",
    Object.keys(Object.fromEntries(Object.entries(encEntries).filter(([, v]) => typeof v === "string" && /^enc:v/.test(v)))));
  process.exit(3);
}
console.error(`[ok] расшифрован ${jwtKey} (JWT ${jwt.length} симв., exp-поле не проверяем здесь)`);

// deviceMid из telemetry-state.json (рядом с credentials.json)
let deviceMid = "";
try {
  const telePath = credentialsPath.replace(/[^/\\]+$/, "") + "telemetry-state.json";
  if (existsSync(telePath)) deviceMid = JSON.parse(readFileSync(telePath, "utf8")).deviceMid ?? "";
} catch { /* необязательно */ }

const platformKey = osPlatform() === "win32" ? "win32-x64" : osPlatform() === "darwin" ? "darwin-arm64" : "linux-x64";
const headers = {
  "Authorization": `Bearer ${jwt}`,
  "User-Agent": `ZCode/${appVersion}`,
  "HTTP-Referer": "https://zcode.z.ai",
  "X-Title": "Z Code@electron",
  "X-ZCode-App-Version": appVersion,
  "X-Platform": platformKey,
  "X-Release-Channel": "1",
  "X-Client-Language": "ru-RU",
  "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
  "X-Os-Category": osPlatform(),
  "x-request-id": randomUUID(),
  ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  "Content-Type": "application/json",
};

async function api(method, path, body) {
  const url = origin + path;
  const resp = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: resp.status, json, text };
}

// ---------- 1) preview ----------
console.error(`[preview] GET /api/v1/zcode-plan/billing/preview?app_version=${appVersion}&platform=${platformKey}`);
const preview = await api("GET", `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platformKey)}`);
console.log("preview HTTP", preview.status);
if (preview.json) {
  const d = preview.json.data ?? {};
  const plans = d.plans ?? [];
  console.log("code:", preview.json.code, "| планов:", plans.length, "| server_time:", d.server_time);
  for (const p of plans) {
    const grants = (p.entitlements ?? [])
      .filter((e) => e.meter === "model_usage" && e.unit_type === "token")
      .map((e) => `${e.show_name}: ${e.grant_units} token (${e.period})`)
      .join("; ");
    console.log(`  - ${p.plan_id} «${p.name}» priority=${p.priority}${grants ? " | " + grants : ""}`);
  }
  if (!plans.length) console.log("  (полный ответ data)", JSON.stringify(d).slice(0, 400));
} else {
  console.log(preview.text.slice(0, 400));
}

// ---------- 2) claim без капчи ----------
if (claimPlanId) {
  console.error(`[claim] POST /api/v1/zcode-plan/billing/claim {plan_id: ${claimPlanId}} — без капча-заголовков`);
  const claim = await api("POST", "/api/v1/zcode-plan/billing/claim", { plan_id: claimPlanId });
  console.log("claim HTTP", claim.status, "code:", claim.json?.code);
  console.log(JSON.stringify(claim.json ?? claim.text.slice(0, 500), null, 2).slice(0, 1200));
}

// ---------- 3) activation events (триггер выдачи, без капчи) ----------
if (doEvents) {
  const userId = (() => {
    for (const [k, v] of Object.entries(encEntries)) {
      if (/user_info/.test(k) && typeof v === "string") {
        try { return JSON.parse(v).user_id ?? ""; } catch { /* ignore */ }
      }
    }
    return "";
  })();
  console.error(`[events] POST /api/v1/event/report (app_launch + app_daily_active, user_id=${userId || "?"})`);
  for (const element of ["app_launch", "app_daily_active"]) {
    const payload = {
      event_id: randomUUID(),
      client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      client_language: "ru-RU",
      element_name: element,
      event_region: "app",
      event_type: "view",
      event_text: "",
      event_extra_detail: {},
      user_id: userId,
      screen_resolution: "2560x1440",
      app_version: appVersion,
      device_os_category: osPlatform(),
      device_os_version: "",
      device_mid: deviceMid,
      mac_id: "",
      marketing_params: "{}",
    };
    const r = await api("POST", "/api/v1/event/report", payload);
    console.log(`  ${element}: HTTP ${r.status} code: ${r.json?.code ?? "?"}`);
  }
}
