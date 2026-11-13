// claim/mint.ts — минт Aliyun traceless captcha verifyParam в-process (happy-dom).
// Ядро — вендоред солвер TriDefender (src/vendor/captcha-happy.ts, CC BY-NC-SA 4.0).
// Здесь только клеймовый клей: конфиг капчи (публичный client/configs с фолбэком
// на константы из реверса десктоп-клиента 3.18.1), ретрай-лесенка и классификация
// ошибок (F008-дубликат / IP-блок / сталь-таймаут) — по референсу captcha-token.ts.
import { solveTraceless } from "../vendor/captcha-happy.js";

export interface CaptchaConfig {
  enabled: boolean;
  prefix: string;
  sceneId: string;
  region: string;
}

/** Константы капчи из реверса десктоп-клиента 3.18.1 (data.configs.captcha). */
export const FALLBACK_CAPTCHA_CONFIG: CaptchaConfig = {
  enabled: true,
  prefix: "no8xfe",
  sceneId: "11xygtvd",
  region: "sgp",
};

const CONFIGS_URL = "https://zcode.z.ai/api/v1/client/configs";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Конфиг капчи. Эндпоинт публичный (официальная тулза TriDefender ходит на него
 * без авторизации) — при сбое молча берём фолбэк-константы: сервер лишь изредка
 * ротирует их, а claim-путь лучше живёт без сети configs, чем умирает.
 */
export async function fetchCaptchaConfig(appVersion: string, platform: string, timeoutMs = 15_000): Promise<CaptchaConfig> {
  try {
    const resp = await fetch(
      `${CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": `ZCode/${appVersion}`, "HTTP-Referer": "https://zcode.z.ai", "X-Title": "Z Code@electron" },
      },
    );
    if (!resp.ok) return FALLBACK_CAPTCHA_CONFIG;
    const json = (await resp.json()) as { data?: { configs?: { captcha?: Partial<CaptchaConfig> } } };
    const cfg = json?.data?.configs?.captcha;
    if (
      cfg &&
      typeof cfg.prefix === "string" && cfg.prefix !== "" &&
      typeof cfg.sceneId === "string" && cfg.sceneId !== "" &&
      typeof cfg.region === "string" && cfg.region !== ""
    ) {
      return { enabled: cfg.enabled !== false, prefix: cfg.prefix, sceneId: cfg.sceneId, region: cfg.region };
    }
  } catch {
    // сеть/таймаут/не-JSON — фолбэк
  }
  return FALLBACK_CAPTCHA_CONFIG;
}

// ---- классификация ошибок (порт captcha-token.ts TriDefender) ----

/** Aliyun F008 — certifyId/verify token уже использован или продублирован. */
export function isCaptchaDuplicateError(message: string): boolean {
  return /F008|"verifyCode"\s*:\s*"F008"/i.test(message);
}

/** IP-блок Aliyun («too many captcha requests» и родня) — ретрай с того же IP бессмыслен. */
const CAPTCHA_IP_BLOCK_RE =
  /too many|request was denied|risk control|frequent|rate\s*limit|exceeded.*(?:request|limit)|ip\s*suspicious|denied due to|retry later/i;

export function isCaptchaIpBlockError(message: string): boolean {
  if (isCaptchaDuplicateError(message)) return false;
  return CAPTCHA_IP_BLOCK_RE.test(message);
}

export class CaptchaFatalError extends Error {
  readonly kind: "duplicate" | "ip-block";
  constructor(kind: "duplicate" | "ip-block", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface MintResult {
  verifyParam: string;
  region: string;
  certifyId: string;
}

/** certifyId из base64-блоба verifyParam (для логов — не функционально). */
export function parseCertifyId(param: string): string {
  try {
    const json = JSON.parse(Buffer.from(param, "base64").toString("utf8")) as { certifyId?: unknown };
    return typeof json.certifyId === "string" ? json.certifyId : "";
  } catch {
    return "";
  }
}

export interface MintOptions {
  attempts?: number;
  backoffMs?: number;
  solveTimeoutMs?: number;
  /** Прогресс в stderr/stdout-лог CLI-процесса */
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Минт verifyParam с ретрай-лесенкой: каждая попытка — свежий solve
 * (свежий certifyId, поэтому F008 между попытками не наследится).
 * F008/IP-блок — фатальны (ретрай не лечит), сталь/таймаут — ретраятся.
 */
export async function mintVerifyParam(cfg: CaptchaConfig, opts: MintOptions = {}): Promise<MintResult> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 2_000;
  const log = opts.log ?? (() => {});
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    try {
      log(`[mint] попытка ${attempt}/${attempts}: scene=${cfg.sceneId} region=${cfg.region} prefix=${cfg.prefix}`);
      const param = await solveTraceless({
        scene: cfg.sceneId,
        region: cfg.region,
        prefix: cfg.prefix,
        ...(opts.solveTimeoutMs ? { timeoutMs: opts.solveTimeoutMs } : {}),
      });
      if (typeof param !== "string" || param.length === 0) throw new Error("солвер вернул пустой verifyParam");
      const certifyId = parseCertifyId(param);
      log(`[mint] ок за ${Date.now() - startedAt}мс, certifyId=${certifyId || "?"}, параметр ${param.length} симв.`);
      return { verifyParam: param, region: cfg.region, certifyId };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = errMsg(lastErr);
      if (isCaptchaDuplicateError(msg)) {
        throw new CaptchaFatalError("duplicate", `капча: F008 certifyId уже использован — ${msg}`);
      }
      if (isCaptchaIpBlockError(msg)) {
        throw new CaptchaFatalError("ip-block", `капча: IP-блок Aliyun (ретрай с этого IP бесполезен) — ${msg}`);
      }
      log(`[mint] неудача (${Date.now() - startedAt}мс): ${msg}`);
      if (attempt < attempts) await sleep(backoffMs);
    }
  }
  throw new Error(`капча не решена за ${attempts} попыток: ${errMsg(lastErr)}`);
}
