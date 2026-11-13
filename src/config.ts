// Конфиг оркестратора: env-переменные + опциональный JSON-файл (ORCHESTRA_CONFIG).
// Приоритет: env > JSON-файл > дефолты. Все ошибки валидации — фатальные при старте.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface AccountConfig {
  name: string;
  /** Абсолютный путь к credentials.json аккаунта; null — общий ~/.zcode */
  credentialsFile: string | null;
  /** Абсолютный путь к provider-config аккаунта; null — общий ~/.zcode */
  providerConfigFile: string | null;
  /** Модель по умолчанию для задач этого аккаунта */
  model: string;
}

export interface OrchestraConfig {
  /** Bearer-токен HTTP-транспорта (обязателен в http-режиме) */
  token: string;
  port: number;
  transport: "http" | "stdio";
  /** Максимальное число параллельных процессов zcode (семафор) */
  maxParallel: number;
  /**
   * Минимальный интервал между СТАРТАМИ задач (мс). Стартовый burst zcode-рантайма
   * (загрузка каталога + разогрев нативного процесса) — пик памяти; на слабых хостах
   * одновременный старт двух задач уходит в OOM. 0 = стартовать без разнесения.
   */
  startStaggerMs: number;
  accounts: AccountConfig[];
  /** Бинарник zcode CLI */
  zcodeBin: string;
  /** База для относительных workdir */
  workdirRoot: string;
  /** Каталог журнала задач (jobs.json + jobs/<jobId>.log) */
  dataDir: string;
}

export const DEFAULT_MODEL = "account:zai-start-plan/GLM-5.3-Flash";

type FileConfig = Partial<{
  token: string;
  port: number;
  transport: string;
  maxParallel: number;
  startStaggerMs: number;
  accounts: unknown;
  zcodeBin: string;
  workdirRoot: string;
  dataDir: string;
}>;

function fail(msg: string): never {
  throw new Error(`конфиг: ${msg}`);
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(`${what}: ожидалась непустая строка`);
  return v;
}

function asPort(v: unknown, what: string, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`${what}: ожидался порт 1..65535, получено «${v}»`);
  return n;
}

function asTransport(v: unknown, fallback: "http" | "stdio"): "http" | "stdio" {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (s !== "http" && s !== "stdio") fail(`transport: ожидалось http|stdio, получено «${v}»`);
  return s;
}

function asMaxParallel(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 1 || n > 64) fail(`maxParallel: ожидалось целое 1..64, получено «${v}»`);
  return n;
}

function asStagger(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0 || n > 600_000) fail(`startStaggerMs: ожидалось целое 0..600000, получено «${v}»`);
  return n;
}

/** Валидация массива аккаунтов. Формат элемента: {name, credentialsFile?, providerConfigFile?, model?} */
function asAccounts(v: unknown, source: string): AccountConfig[] {
  let raw = v;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      fail(`${source}: невалидный JSON аккаунтов (${(e as Error).message})`);
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) fail(`${source}: ожидался непустой JSON-массив аккаунтов`);
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== "object") fail(`${source}[${i}]: ожидался объект аккаунта`);
    const a = entry as Record<string, unknown>;
    const name = asString(a.name, `${source}[${i}].name`);
    if (seen.has(name)) fail(`${source}: дублирующееся имя аккаунта «${name}»`);
    seen.add(name);
    return {
      name,
      credentialsFile: optFilePath(a.credentialsFile, `${source}[${i}].credentialsFile`),
      providerConfigFile: optFilePath(a.providerConfigFile, `${source}[${i}].providerConfigFile`),
      model: typeof a.model === "string" && a.model.trim() !== "" ? a.model : DEFAULT_MODEL,
    };
  });
}

/** Путь-переопределение: null/пусто → null; иначе обязан быть абсолютным */
function optFilePath(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  if (!isAbsolute(s)) fail(`${what}: ожидался абсолютный путь, получено «${s}»`);
  return s;
}

/**
 * Собирает конфиг из env + опционального JSON-файла (ORCHESTRA_CONFIG).
 * Ключи файла — camelCase: {token, port, transport, maxParallel, accounts, zcodeBin, workdirRoot, dataDir}.
 * Env-переменные имеют приоритет над файлом (файл — «база», env — явное переопределение).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestraConfig {
  // 1) JSON-файл как база
  let file: FileConfig = {};
  if (env.ORCHESTRA_CONFIG) {
    let raw: string;
    try {
      raw = readFileSync(env.ORCHESTRA_CONFIG, "utf8");
    } catch (e) {
      fail(`ORCHESTRA_CONFIG=${env.ORCHESTRA_CONFIG}: файл не читается (${(e as Error).message})`);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("ORCHESTRA_CONFIG: ожидался JSON-объект");
      file = parsed as FileConfig;
    } catch (e) {
      if ((e as Error).message.startsWith("конфиг:")) throw e;
      fail(`ORCHESTRA_CONFIG: невалидный JSON (${(e as Error).message})`);
    }
  }

  // 2) env поверх файла
  const token = env.ORCHESTRA_TOKEN !== undefined && env.ORCHESTRA_TOKEN !== "" ? env.ORCHESTRA_TOKEN : file.token ?? "";
  const port = asPort(env.ORCHESTRA_PORT ?? file.port, "ORCHESTRA_PORT", 8787);
  const transport = asTransport(env.ORCHESTRA_TRANSPORT ?? file.transport, "http");
  const maxParallel = asMaxParallel(env.ORCHESTRA_MAX_PARALLEL ?? file.maxParallel, 2);
  const startStaggerMs = asStagger(env.ORCHESTRA_START_STAGGER_MS ?? file.startStaggerMs, 20_000);
  const zcodeBin = env.ORCHESTRA_ZCODE_BIN !== undefined && env.ORCHESTRA_ZCODE_BIN !== "" ? env.ORCHESTRA_ZCODE_BIN : file.zcodeBin ?? "zcode";
  const workdirRoot =
    env.ORCHESTRA_WORKDIR_ROOT !== undefined && env.ORCHESTRA_WORKDIR_ROOT !== ""
      ? env.ORCHESTRA_WORKDIR_ROOT
      : file.workdirRoot ?? "/workspace";
  const dataDir = env.ORCHESTRA_DATA_DIR !== undefined && env.ORCHESTRA_DATA_DIR !== "" ? env.ORCHESTRA_DATA_DIR : file.dataDir ?? "./data";

  // 3) аккаунты: env ORCHESTRA_ACCOUNTS полностью заменяет файловый список
  let accounts: AccountConfig[];
  if (env.ORCHESTRA_ACCOUNTS !== undefined && env.ORCHESTRA_ACCOUNTS !== "") {
    accounts = asAccounts(env.ORCHESTRA_ACCOUNTS, "ORCHESTRA_ACCOUNTS");
  } else if (file.accounts !== undefined) {
    accounts = asAccounts(file.accounts, "ORCHESTRA_CONFIG.accounts");
  } else {
    accounts = [{ name: "main", credentialsFile: null, providerConfigFile: null, model: DEFAULT_MODEL }];
  }

  // 4) фатальная валидация http-режима
  if (transport === "http" && token.trim() === "") {
    fail("ORCHESTRA_TOKEN пуст — в http-режиме bearer-токен обязателен (либо переключите ORCHESTRA_TRANSPORT=stdio)");
  }

  return { token, port, transport, maxParallel, startStaggerMs, accounts, zcodeBin, workdirRoot, dataDir };
}

/** Поиск аккаунта по имени; пусто/undefined → «main». Неизвестное имя — ошибка. */
export function findAccount(config: OrchestraConfig, name?: string): AccountConfig {
  const wanted = (name ?? "").trim() === "" ? "main" : (name as string).trim();
  const acc = config.accounts.find((a) => a.name === wanted);
  if (!acc) {
    const known = config.accounts.map((a) => a.name).join(", ");
    throw new Error(`аккаунт «${wanted}» не найден; доступные аккаунты: ${known}`);
  }
  return acc;
}
