// Конфиг оркестратора: env-переменные + опциональный JSON-файл (ORCHESTRA_CONFIG).
// Приоритет: env > JSON-файл > дефолты. Все ошибки валидации — фатальные при старте.
// Поверх статики накладывается runtime-реестр <dataDir>/registry.json (тулзы
// account_add / notify_setup): динамические аккаунты, chat id юзеров, их списки аккаунтов.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { timingSafeEqual } from "node:crypto";

export interface AccountConfig {
  name: string;
  /** Абсолютный путь к credentials.json аккаунта; null — общий ~/.zcode */
  credentialsFile: string | null;
  /** Абсолютный путь к provider-config аккаунта; null — общий ~/.zcode */
  providerConfigFile: string | null;
  /** Модель по умолчанию для задач этого аккаунта */
  model: string;
  /** Переопределение Telegram chat id для уведомлений этого аккаунта (иначе — chat id владельца-юзера) */
  notifyChatId?: number;
}

/** Пользователь MCP: свой bearer-токен, свой набор аккаунтов, свой Telegram chat для уведомлений. */
export interface UserConfig {
  name: string;
  token: string;
  /** Имена доступных аккаунтов или "*" — все */
  accounts: string[];
  /** Telegram chat id для уведомлений (передаётся при настройке MCP у юзера) */
  chatId?: number;
}

export interface OrchestraConfig {
  /** Bearer-токен HTTP-транспорта (обязателен в http-режиме; совместимость — одиночный токен) */
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
  /** Пользователи MCP (токен → аккаунты + chat id уведомлений); минимум один */
  users: UserConfig[];
  /** Автоклейм: планировщик тикает discovery и клеймит появившиеся активности */
  claimAuto: boolean;
  /** Интервал тика автоклейма (мс) */
  claimIntervalMs: number;
  /** Час МСК, с которого начинаются тики автоклейма (раздачи появляются после 14:00) */
  claimAfterHourMsk: number;
  /** Час МСК для пятницы (weekend-раздача появляется после 17:00) */
  claimFridayAfterHourMsk: number;
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
  users: unknown;
  claimAuto: boolean;
  claimIntervalMs: number;
  claimAfterHourMsk: number;
  claimFridayAfterHourMsk: number;
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

/** Валидация массива аккаунтов. Формат элемента: {name, credentialsFile?, providerConfigFile?, model?, notifyChatId?} */
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
      ...(a.notifyChatId === undefined ? {} : { notifyChatId: asChatId(a.notifyChatId, `${source}[${i}].notifyChatId`) }),
    };
  });
}

function asChatId(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n <= 0) fail(`${what}: ожидался положительный целый chat id, получено «${v}»`);
  return n;
}

function asBool(v: unknown, what: string, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  fail(`${what}: ожидалось true|false, получено «${v}»`);
}

function asInterval(v: unknown, what: string, fallback: number, min: number, max: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) fail(`${what}: ожидалось целое ${min}..${max}, получено «${v}»`);
  return n;
}

/** Валидация массива пользователей: [{name, token, accounts: ["main"|"*"], chatId?}] */
function asUsers(v: unknown, accountNames: string[], source: string): UserConfig[] {
  let raw = v;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      fail(`${source}: невалидный JSON пользователей (${(e as Error).message})`);
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) fail(`${source}: ожидался непустой JSON-массив пользователей`);
  const seenName = new Set<string>();
  const seenToken = new Set<string>();
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== "object") fail(`${source}[${i}]: ожидался объект пользователя`);
    const u = entry as Record<string, unknown>;
    const name = asString(u.name, `${source}[${i}].name`);
    if (seenName.has(name)) fail(`${source}: дублирующееся имя пользователя «${name}»`);
    seenName.add(name);
    const token = asString(u.token, `${source}[${i}].token`);
    if (seenToken.has(token)) fail(`${source}: дублирующийся токен пользователя «${name}»`);
    seenToken.add(token);
    let accounts: string[];
    if (typeof u.accounts === "string" && u.accounts.trim() === "*") {
      accounts = ["*"];
    } else {
      if (!Array.isArray(u.accounts) || u.accounts.length === 0) {
        fail(`${source}[${i}].accounts: ожидался непустой массив имён аккаунтов или "*"`);
      }
      accounts = (u.accounts as unknown[]).map((a, j) => {
        const an = asString(a, `${source}[${i}].accounts[${j}]`);
        if (!accountNames.includes(an)) {
          fail(`${source}[${i}].accounts[${j}]: аккаунт «${an}» не найден (доступные: ${accountNames.join(", ")})`);
        }
        return an;
      });
    }
    return {
      name,
      token,
      accounts,
      ...(u.chatId === undefined || u.chatId === null || u.chatId === "" ? {} : { chatId: asChatId(u.chatId, `${source}[${i}].chatId`) }),
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

  // 3) аккаунты: env ORCHESTRA_ACCOUNTS полностью заменяет файловый список
  let accounts: AccountConfig[];
  if (env.ORCHESTRA_ACCOUNTS !== undefined && env.ORCHESTRA_ACCOUNTS !== "") {
    accounts = asAccounts(env.ORCHESTRA_ACCOUNTS, "ORCHESTRA_ACCOUNTS");
  } else if (file.accounts !== undefined) {
    accounts = asAccounts(file.accounts, "ORCHESTRA_CONFIG.accounts");
  } else {
    accounts = [{ name: "main", credentialsFile: null, providerConfigFile: null, model: DEFAULT_MODEL }];
  }

  // 3b) пользователи: env ORCHESTRA_USERS полностью заменяет файловый список;
  // без явного списка — один «default» с общим токеном и доступом ко всем аккаунтам
  let users: UserConfig[];
  if (env.ORCHESTRA_USERS !== undefined && env.ORCHESTRA_USERS !== "") {
    users = asUsers(env.ORCHESTRA_USERS, accounts.map((a) => a.name), "ORCHESTRA_USERS");
  } else if (file.users !== undefined) {
    users = asUsers(file.users, accounts.map((a) => a.name), "ORCHESTRA_CONFIG.users");
  } else {
    users = [{ name: (env.ORCHESTRA_USER_NAME ?? "").trim() || "default", token, accounts: ["*"] }];
  }

  const claimAuto = asBool(env.ORCHESTRA_CLAIM_AUTO ?? file.claimAuto, "ORCHESTRA_CLAIM_AUTO", true);
  const claimIntervalMs = asInterval(env.ORCHESTRA_CLAIM_INTERVAL_MS ?? file.claimIntervalMs, "ORCHESTRA_CLAIM_INTERVAL_MS", 600_000, 60_000, 3_600_000);
  const claimAfterHourMsk = asInterval(env.ORCHESTRA_CLAIM_AFTER_MSK ?? file.claimAfterHourMsk, "ORCHESTRA_CLAIM_AFTER_MSK", 14, 0, 23);
  const claimFridayAfterHourMsk = asInterval(env.ORCHESTRA_CLAIM_FRIDAY_AFTER_MSK ?? file.claimFridayAfterHourMsk, "ORCHESTRA_CLAIM_FRIDAY_AFTER_MSK", 17, 0, 23);

  // 3c) runtime-реестр (тулзы account_add / notify_setup пишут его в dataDir) — поверх статики
  const dataDir = env.ORCHESTRA_DATA_DIR !== undefined && env.ORCHESTRA_DATA_DIR !== ""
    ? env.ORCHESTRA_DATA_DIR
    : file.dataDir ?? "./data";
  applyRuntimeRegistry(dataDir, accounts, users);

  // 4) фатальная валидация http-режима
  if (transport === "http" && token.trim() === "") {
    fail("ORCHESTRA_TOKEN пуст — в http-режиме bearer-токен обязателен (либо переключите ORCHESTRA_TRANSPORT=stdio)");
  }

  return { token, port, transport, maxParallel, startStaggerMs, accounts, users, claimAuto, claimIntervalMs, claimAfterHourMsk, claimFridayAfterHourMsk, zcodeBin, workdirRoot, dataDir };
}

interface RegistryEntry {
  name: string;
  owner?: string;
  credentialsFile?: string;
  model?: string;
  notifyChatId?: number;
}

/** Наложение runtime-реестра на статические accounts/users (пропавшего файла нет — ок). */
function applyRuntimeRegistry(dataDir: string, accounts: AccountConfig[], users: UserConfig[]): void {
  const registryPath = join(dataDir, "registry.json");
  if (!existsSync(registryPath)) return;
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf8")) as {
      accounts?: RegistryEntry[];
      userChatIds?: Record<string, number>;
      userAccounts?: Record<string, string[]>;
    };
    for (const ra of reg.accounts ?? []) {
      if (!ra?.name || accounts.some((a) => a.name === ra.name)) continue; // статика сильнее реестра при конфликте имён
      accounts.push({
        name: ra.name,
        credentialsFile: typeof ra.credentialsFile === "string" && isAbsolute(ra.credentialsFile) ? ra.credentialsFile : null,
        providerConfigFile: null,
        model: typeof ra.model === "string" && ra.model.trim() !== "" ? ra.model : DEFAULT_MODEL,
        ...(Number.isInteger(ra.notifyChatId) ? { notifyChatId: ra.notifyChatId as number } : {}),
      });
    }
    for (const [userName, chatId] of Object.entries(reg.userChatIds ?? {})) {
      const u = users.find((x) => x.name === userName);
      if (u && Number.isInteger(chatId) && (chatId as number) > 0) u.chatId = chatId as number;
    }
    for (const [userName, accs] of Object.entries(reg.userAccounts ?? {})) {
      const u = users.find((x) => x.name === userName);
      if (u && Array.isArray(accs) && accs.every((a) => typeof a === "string")) u.accounts = accs as string[];
    }
  } catch (e) {
    console.error(`конфиг: реестр ${registryPath} повреждён и проигнорирован: ${e instanceof Error ? e.message : String(e)}`);
  }
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

/**
 * Поиск аккаунта в скоупе пользователя; пусто/undefined → «main» (или первый
 * доступный). Чужой/неизвестный аккаунт — ошибка со списком доступных.
 */
export function findUserAccount(config: OrchestraConfig, user: UserConfig, name?: string): AccountConfig {
  const allowed = user.accounts.includes("*") ? config.accounts.map((a) => a.name) : user.accounts;
  const wanted = (name ?? "").trim() === "" ? (allowed.includes("main") ? "main" : (allowed[0] ?? "")) : (name as string).trim();
  if (wanted === "" || !allowed.includes(wanted)) {
    throw new Error(`аккаунт «${wanted || "?"}» недоступен пользователю «${user.name}»; доступные: ${allowed.join(", ")}`);
  }
  const acc = config.accounts.find((a) => a.name === wanted);
  if (!acc) {
    const known = config.accounts.map((a) => a.name).join(", ");
    throw new Error(`аккаунт «${wanted}» не найден в конфиге; доступные аккаунты: ${known}`);
  }
  return acc;
}

/** Разрешение bearer-токена → пользователь; не найден — null. Сравнение constant-time. */
export function resolveUser(config: OrchestraConfig, token: string): UserConfig | null {
  const supplied = Buffer.from(token, "utf8");
  for (const u of config.users) {
    const known = Buffer.from(u.token, "utf8");
    if (known.length === supplied.length && timingSafeEqual(known, supplied)) return u;
  }
  return null;
}
