// Менеджер задач: очередь, семафор параллелизма, spawn zcode -p <brief>,
// журналирование на диск (jobs.json + jobs/<jobId>.log), отмена, разбор результата.
// Экономный по RAM: в памяти только метаданные и хвосты stdout/stderr, полный вывод — в файл.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import type { WriteStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findAccount, type AccountConfig, type OrchestraConfig } from "./config.js";
import { log } from "./logger.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

const BRIEF_SNIPPET = 200; // столько символов брифа храним в журнале
const RESULT_SNIPPET = 4000; // столько символов результата храним в журнале
const ERROR_SNIPPET = 2000; // последние N символов stderr+stdout в ошибке
const STDOUT_TAIL_CAP = 512 * 1024; // хвост stdout в памяти (для разбора финального JSON)
const STDERR_TAIL_CAP = 64 * 1024; // хвост stderr в памяти (для текста ошибки)
const KILL_GRACE_MS = 10_000; // SIGTERM → через 10с SIGKILL
const LOG_READ_WINDOW = 64 * 1024; // читаем лог хвостом не более 64КБ

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  brief: string; // первые BRIEF_SNIPPET символов
  workdir: string;
  account: string;
  model: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  usage: unknown | null;
  result: string | null; // первые RESULT_SNIPPET символов результата
  sessionId: string | null;
  error: string | null;
}

export interface SubmitArgs {
  brief: string;
  workdir?: string;
  model?: string;
  effort?: string;
  resume?: string;
  account?: string;
}

export interface SubmitResult {
  jobId: string;
  status: JobStatus;
  position: number; // 0 — задача уже стартовала, иначе место в очереди (1..)
}

export interface StatusInfo {
  record: JobRecord;
  logTail: string | null;
}

interface JobRuntime {
  record: JobRecord;
  child: ChildProcess | null;
  stdoutTail: string;
  stderrTail: string;
  killed: boolean; // отменена пользователем/шатдауном
  finished: boolean;
  counted: boolean; // учтена в this.active (декремент в терминальных состояниях)
  logStream: WriteStream | null;
  stderrMarked: boolean;
  waiters: Array<(r: JobRecord) => void>;
  // Полные параметры спавна (в record.brief хранится только обрезок для журнала)
  fullBrief: string;
  effort?: string;
  resume?: string;
}

export interface ExtractedResult {
  result?: string;
  sessionId?: string;
  usage?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** Прибавляет кусок к хвосту, обрезая спереди при превышении cap (экономия памяти) */
function pushTail(current: string, chunk: string, cap: number): string {
  const next = current + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

// ---------- Разбор результата zcode --output-format json ----------
// Поля могут отличаться — ищем рекурсивно: /result|text/, /session/i, /usage|tokens/i.

function balancedSlice(text: string, start: number, maxLen = 2_000_000): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length && i - start < maxLen; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Ищет последний осмысленный JSON-объект в хвосте stdout */
function findLastJsonObject(text: string): unknown | undefined {
  // 1) построчно с конца (обычный случай: финальная строка = JSON)
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("{")) {
      try {
        return JSON.parse(line);
      } catch {
        // пробуем дальше
      }
    }
  }
  // 2) склеенный/многострочный JSON: скобочный баланс с последних '{'
  let attempts = 0;
  for (let i = text.length - 1; i >= 0 && attempts < 20; i--) {
    if (text[i] !== "{") continue;
    attempts++;
    const candidate = balancedSlice(text, i);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // пробуем дальше
    }
  }
  return undefined;
}

/** BFS по объекту/массиву; возвращает первое значение, подошедшее под предикат (shallow-first) */
function bfsFindValue(
  root: unknown,
  pred: (key: string, value: unknown) => boolean,
  maxNodes = 2000,
): unknown | undefined {
  const queue: unknown[] = [root];
  let nodes = 0;
  while (queue.length > 0) {
    const v = queue.shift();
    if (v === null || typeof v !== "object") continue;
    if (++nodes > maxNodes) return undefined;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (pred(k, val)) return val;
      if (val !== null && typeof val === "object") queue.push(val);
    }
  }
  return undefined;
}

function deepFindString(root: unknown, exactKeys: string[], pattern: RegExp): string | undefined {
  const exact = bfsFindValue(root, (k, v) => exactKeys.includes(k) && typeof v === "string" && v.trim() !== "");
  if (typeof exact === "string") return exact;
  const fuzzy = bfsFindValue(root, (k, v) => pattern.test(k) && typeof v === "string" && v.trim() !== "");
  return typeof fuzzy === "string" ? fuzzy : undefined;
}

function deepFindUsage(root: unknown): unknown | undefined {
  const exact = bfsFindValue(root, (k, v) => k === "usage" && v !== null && (typeof v === "object" || typeof v === "number"));
  if (exact !== undefined) return exact;
  return bfsFindValue(root, (k, v) => /usage|tokens/i.test(k) && v !== null && (typeof v === "object" || typeof v === "number"));
}

/** Толерантное извлечение result / session_id / usage из финального JSON */
function extractResult(stdoutTail: string): ExtractedResult {
  const trimmed = stdoutTail.trim();
  if (trimmed === "") return {};
  const obj = findLastJsonObject(stdoutTail);
  if (obj === undefined || obj === null || typeof obj !== "object") return {};
  const result = deepFindString(obj, ["result", "text"], /result|text/i);
  const sessionId = deepFindString(obj, ["session_id", "sessionId", "session"], /session/i);
  const usage = deepFindUsage(obj);
  const out: ExtractedResult = {};
  if (result !== undefined) out.result = result;
  if (sessionId !== undefined) out.sessionId = sessionId;
  if (usage !== undefined) out.usage = usage;
  return out;
}

/** Читает последние maxChars символов файла (большой файл — окном с конца) */
async function readTailFile(filePath: string, maxChars: number): Promise<string | null> {
  try {
    const fh = await open(filePath, "r");
    try {
      const st = await fh.stat();
      if (st.size === 0) return "";
      const window = Math.min(st.size, LOG_READ_WINDOW);
      const buf = Buffer.alloc(window);
      await fh.read(buf, 0, window, st.size - window);
      return buf.toString("utf8").slice(-maxChars);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export class Runner {
  private readonly config: OrchestraConfig;
  private readonly jobs = new Map<string, JobRuntime>();
  private readonly logDir: string;
  private readonly jobsPath: string;
  private queue: string[] = [];
  private active = 0;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(config: OrchestraConfig) {
    this.config = config;
    this.logDir = path.join(config.dataDir, "jobs");
    this.jobsPath = path.join(config.dataDir, "jobs.json");
    mkdirSync(this.logDir, { recursive: true });
    this.loadJournal();
  }

  // ---------- журнал на диске ----------

  /** Загружает jobs.json; задачи, застрявшие в running/queued без процесса, помечает failed */
  private loadJournal(): void {
    let raw: string;
    try {
      raw = readFileSync(this.jobsPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`журнал ${this.jobsPath} не прочитан: ${errMsg(e)}`);
      }
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const jobs = (parsed as { jobs?: Record<string, JobRecord> }).jobs ?? {};
      let interrupted = 0;
      for (const [jobId, rec] of Object.entries(jobs)) {
        if (rec.status === "running" || rec.status === "queued") {
          // PID не сохраняем — после рестарта процесс-сирота неуправляем: считаем задачу failed
          rec.status = "failed";
          rec.error = "задача прервана рестартом сервера";
          rec.finishedAt = rec.finishedAt ?? nowIso();
          rec.exitCode = null;
          interrupted++;
        }
        this.jobs.set(jobId, {
          record: rec,
          child: null,
          stdoutTail: "",
          stderrTail: "",
          killed: false,
          finished: true,
          counted: false,
          logStream: null,
          stderrMarked: false,
          waiters: [],
          fullBrief: rec.brief,
        });
      }
      if (this.jobs.size > 0) {
        this.schedulePersist();
        log(`журнал: загружено ${this.jobs.size} задач${interrupted > 0 ? `, ${interrupted} прерванных помечено failed` : ""}`);
      }
    } catch (e) {
      log(`журнал ${this.jobsPath} повреждён и проигнорирован: ${errMsg(e)}`);
    }
  }

  /** Атомарная перезапись jobs.json (tmp + rename), цепочкой без параллельных записей */
  private schedulePersist(): void {
    this.persistChain = this.persistChain
      .then(async () => {
        const payload = {
          version: 1,
          updatedAt: nowIso(),
          jobs: Object.fromEntries(Array.from(this.jobs.entries(), ([id, rt]) => [id, rt.record])),
        };
        const tmp = `${this.jobsPath}.tmp`;
        await writeFile(tmp, JSON.stringify(payload), "utf8");
        await rename(tmp, this.jobsPath);
      })
      .catch((e) => log(`не удалось записать журнал: ${errMsg(e)}`));
  }

  // ---------- постановка в очередь ----------

  submit(args: SubmitArgs): SubmitResult {
    if (typeof args.brief !== "string" || args.brief.trim() === "") {
      throw new Error("brief обязателен и не может быть пустым");
    }
    const account = findAccount(this.config, args.account); // кинет, если имя неизвестно
    const model = (args.model ?? "").trim() === "" ? account.model : (args.model as string).trim();
    const workdir = this.resolveWorkdir(args.workdir);
    const effort = (args.effort ?? "").trim() === "" ? undefined : (args.effort as string).trim();
    const resume = (args.resume ?? "").trim() === "" ? undefined : (args.resume as string).trim();

    const jobId = `job-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const record: JobRecord = {
      jobId,
      status: "queued",
      brief: args.brief.slice(0, BRIEF_SNIPPET),
      workdir,
      account: account.name,
      model,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      usage: null,
      result: null,
      sessionId: null,
      error: null,
    };
    this.jobs.set(jobId, {
      record,
      child: null,
      stdoutTail: "",
      stderrTail: "",
      killed: false,
      finished: false,
      counted: false,
      logStream: null,
      stderrMarked: false,
      waiters: [],
      fullBrief: args.brief,
      effort,
      resume,
    });
    // workdir создаём сразу — ранний фейл при недопустимом пути
    try {
      mkdirSync(workdir, { recursive: true });
    } catch (e) {
      this.failJob(this.jobs.get(jobId) as JobRuntime, `не удалось создать workdir ${workdir}: ${errMsg(e)}`);
      throw new Error(`не удалось создать workdir ${workdir}: ${errMsg(e)}`);
    }
    this.queue.push(jobId);
    this.schedulePersist();
    this.pump();
    const rt = this.jobs.get(jobId) as JobRuntime;
    const position = rt.record.status === "queued" ? this.queue.indexOf(jobId) + 1 : 0;
    return { jobId, status: rt.record.status, position };
  }

  /** Относительный workdir резолвится от ORCHESTRA_WORKDIR_ROOT */
  private resolveWorkdir(wd?: string): string {
    const raw = (wd ?? "").trim();
    if (raw === "") return this.config.workdirRoot;
    return path.isAbsolute(raw) ? raw : path.resolve(this.config.workdirRoot, raw);
  }

  private envForAccount(account: AccountConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // изоляция аккаунтов: переопределения хранилищ кредов/провайдера
    if (account.credentialsFile) env.ZCODE_CLI_CREDENTIALS_FILE = account.credentialsFile;
    if (account.providerConfigFile) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = account.providerConfigFile;
    return env;
  }

  /** На Windows spawn не исполняет .mjs/.js напрямую — подставляем текущий node */
  private buildSpawn(bin: string, args: string[]): { cmd: string; args: string[] } {
    if (process.platform === "win32" && /\.(mjs|cjs|js)$/i.test(bin)) {
      return { cmd: process.execPath, args: [bin, ...args] };
    }
    return { cmd: bin, args };
  }

  private pump(): void {
    while (this.active < this.config.maxParallel && this.queue.length > 0) {
      const nextId = this.queue.shift();
      if (!nextId) break;
      const rt = this.jobs.get(nextId);
      if (!rt || rt.record.status !== "queued") continue; // отменённые в очереди пропускаем
      void this.runJob(rt);
    }
  }

  private async runJob(rt: JobRuntime): Promise<void> {
    const rec = rt.record;
    this.active++;
    rt.counted = true;
    rec.status = "running";
    rec.startedAt = nowIso();
    this.schedulePersist();

    let cwd: string;
    try {
      await mkdir(rec.workdir, { recursive: true });
      cwd = rec.workdir;
    } catch (e) {
      this.failJob(rt, `не удалось создать workdir ${rec.workdir}: ${errMsg(e)}`);
      return;
    }

    const account = findAccount(this.config, rec.account);
    // полный бриф из рантайм-структуры (в журнале хранится обрезок до 200 символов)
    const args = ["-p", rt.fullBrief, "--model", rec.model, "--output-format", "json"];
    if (rt.effort) args.push("--effort", rt.effort);
    if (rt.resume) args.push("--resume", rt.resume);

    const logPath = path.join(this.logDir, `${rec.jobId}.log`);
    const logStream = createWriteStream(logPath, { flags: "a" });
    rt.logStream = logStream;
    const { cmd, args: spawnArgs } = this.buildSpawn(this.config.zcodeBin, args);
    logStream.write(`# ${nowIso()} cwd: ${cwd}\n# cmd: ${cmd} ${spawnArgs.join(" ")}\n`);

    const child = spawn(cmd, spawnArgs, { cwd, env: this.envForAccount(account) });
    rt.child = child;
    log(`задача ${rec.jobId} запущена (pid ${child.pid ?? "?"}, аккаунт ${rec.account}, модель ${rec.model})`);

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      logStream.write(s);
      rt.stdoutTail = pushTail(rt.stdoutTail, s, STDOUT_TAIL_CAP);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (!rt.stderrMarked) {
        logStream.write("\n[stderr]\n");
        rt.stderrMarked = true;
      }
      logStream.write(s);
      rt.stderrTail = pushTail(rt.stderrTail, s, STDERR_TAIL_CAP);
    });
    child.on("error", (err) => {
      this.failJob(rt, `spawn не удался: ${err.message}`);
    });
    child.on("close", (code, signal) => {
      this.finishJob(rt, typeof code === "number" ? code : null, signal);
    });
  }

  private failJob(rt: JobRuntime, error: string): void {
    if (rt.finished) return;
    rt.finished = true;
    this.releaseActive(rt);
    const rec = rt.record;
    rec.status = "failed";
    rec.error = error.slice(0, ERROR_SNIPPET);
    rec.finishedAt = nowIso();
    this.cleanupChild(rt);
    this.resolveWaiters(rt);
    this.schedulePersist();
    log(`задача ${rec.jobId} failed: ${error.slice(0, 200)}`);
    this.pump();
  }

  private finishJob(rt: JobRuntime, code: number | null, signal: NodeJS.Signals | null): void {
    if (rt.finished) return;
    rt.finished = true;
    this.releaseActive(rt);
    const rec = rt.record;
    rec.finishedAt = nowIso();
    rec.exitCode = code;
    if (rt.killed) {
      rec.status = "cancelled";
      rec.error = `задача отменена (${signal ?? "SIGTERM/SIGKILL"})`;
    } else if (code === 0) {
      rec.status = "done";
      const parsed = extractResult(rt.stdoutTail);
      // что не нашли — возвращаем raw-хвост stdout
      rec.result = (parsed.result ?? rt.stdoutTail).slice(0, RESULT_SNIPPET);
      rec.sessionId = parsed.sessionId ?? null;
      rec.usage = parsed.usage ?? null;
    } else {
      rec.status = "failed";
      rec.error = (rt.stderrTail + "\n" + rt.stdoutTail).slice(-ERROR_SNIPPET).trim() || `exit code ${code}`;
    }
    this.cleanupChild(rt);
    this.schedulePersist();
    this.resolveWaiters(rt);
    log(`задача ${rec.jobId} ${rec.status} (exit ${code === null ? "-" : code})`);
    this.pump();
  }

  /** Снимает задачу со счётчика параллелизма (только если она реально стартовала) */
  private releaseActive(rt: JobRuntime): void {
    if (rt.counted) {
      rt.counted = false;
      this.active--;
    }
  }

  private cleanupChild(rt: JobRuntime): void {
    rt.child = null;
    if (rt.logStream) {
      rt.logStream.end();
      rt.logStream = null;
    }
  }

  private resolveWaiters(rt: JobRuntime): void {
    const waiters = rt.waiters;
    rt.waiters = [];
    for (const w of waiters) w(rt.record);
  }

  // ---------- публичные операции ----------

  /** Статус задачи + хвост журнала (по умолчанию 1000 символов) */
  async status(jobId: string, logTailChars = 1000): Promise<StatusInfo | null> {
    const rt = this.jobs.get(jobId);
    if (!rt) return null;
    const logTail = await readTailFile(path.join(this.logDir, `${jobId}.log`), logTailChars);
    return { record: rt.record, logTail };
  }

  /** Свежие первыми */
  list(limit = 20): JobRecord[] {
    return Array.from(this.jobs.values())
      .map((rt) => rt.record)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  /** Отмена: queued → снятие с очереди; running → SIGTERM, через 10с SIGKILL */
  async cancel(jobId: string): Promise<JobRecord | null> {
    const rt = this.jobs.get(jobId);
    if (!rt) return null;
    const rec = rt.record;
    if (isTerminal(rec.status)) return rec;

    if (rec.status === "queued") {
      rt.finished = true;
      rec.status = "cancelled";
      rec.error = "отменена в очереди";
      rec.finishedAt = nowIso();
      this.queue = this.queue.filter((id) => id !== jobId);
      this.resolveWaiters(rt);
      this.schedulePersist();
      log(`задача ${jobId} отменена в очереди`);
      return rec;
    }

    // running
    rt.killed = true;
    const child = rt.child;
    if (child && child.exitCode === null && child.pid) {
      try {
        child.kill("SIGTERM");
      } catch (e) {
        log(`SIGTERM для ${jobId} не удался: ${errMsg(e)}`);
      }
      const killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // процесс уже мёртв
        }
      }, KILL_GRACE_MS);
      killTimer.unref();
      log(`задача ${jobId}: отправлен SIGTERM (SIGKILL через ${KILL_GRACE_MS / 1000}с)`);
    }
    return rec; // финальный статус придёт в finishJob
  }

  /** Ждёт завершения задачи, но не дольше timeoutMs; возвращает текущий статус по таймауту */
  waitFor(jobId: string, timeoutMs: number): Promise<JobRecord> {
    const rt = this.jobs.get(jobId);
    if (!rt) return Promise.reject(new Error(`задача ${jobId} не найдена`));
    if (isTerminal(rt.record.status)) return Promise.resolve(rt.record);
    return new Promise<JobRecord>((resolve) => {
      const timer = setTimeout(() => {
        const i = rt.waiters.indexOf(waiter);
        if (i >= 0) rt.waiters.splice(i, 1);
        resolve(rt.record); // таймаут: возвращаем актуальное состояние
      }, timeoutMs);
      timer.unref();
      const waiter = (rec: JobRecord) => {
        clearTimeout(timer);
        resolve(rec);
      };
      rt.waiters.push(waiter);
    });
  }

  /** Число незавершённых задач аккаунта */
  activeForAccount(account: string): number {
    let n = 0;
    for (const rt of this.jobs.values()) {
      if (rt.record.account === account && !isTerminal(rt.record.status)) n++;
    }
    return n;
  }

  /** Счётчики done/failed по журналу */
  statsForAccount(account: string): { done: number; failed: number } {
    let done = 0;
    let failed = 0;
    for (const rt of this.jobs.values()) {
      if (rt.record.account !== account) continue;
      if (rt.record.status === "done") done++;
      else if (rt.record.status === "failed") failed++;
    }
    return { done, failed };
  }

  /** Дожидается завершения асинхронной записи журнала (тесты, шатдаун) */
  async flushJournal(): Promise<void> {
    await this.persistChain;
  }

  /** Шатдаун: queued отменяем, running шлём SIGTERM (SIGKILL по таймеру) */
  async shutdown(): Promise<void> {
    for (const rt of this.jobs.values()) {
      const rec = rt.record;
      if (rec.status === "queued") {
        rt.finished = true;
        rec.status = "cancelled";
        rec.error = "сервер останавливается";
        rec.finishedAt = nowIso();
        this.queue = this.queue.filter((id) => id !== rec.jobId);
        this.resolveWaiters(rt);
      } else if (rec.status === "running") {
        rt.killed = true;
        const child = rt.child;
        if (child && child.exitCode === null && child.pid) {
          try {
            child.kill("SIGTERM");
          } catch {
            // процесс уже мёртв
          }
          const killTimer = setTimeout(() => {
            try {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            } catch {
              // процесс уже мёртв
            }
          }, KILL_GRACE_MS);
          killTimer.unref();
        }
      }
    }
    this.schedulePersist();
  }

  get dataDir(): string {
    return this.config.dataDir;
  }
}
