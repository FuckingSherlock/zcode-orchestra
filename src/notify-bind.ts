// notify-bind.ts — привязка Telegram по одноразовым кодам (юзеру не нужно
// узнавать свой chat id): notify_code() выдаёт код, юзер отправляет его боту,
// биндер опрашивает воркер (/tg-wait — getUpdates с буфером на его стороне) и
// привязывает chat id к пользователю оркестра. Подтверждение приходит в TG.
// Один бот на всех: буфер в воркере общий, каждый код находится ровно один раз.
import type { OrchestraConfig, UserConfig } from "./config.js";
import { persistRegistryState } from "./accounts.js";
import { notify } from "./notify.js";
import { log } from "./logger.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без 0/O/1/I

interface PendingCode {
  code: string;
  userName: string;
  expiresAt: number;
  chatId?: number;
  fromName?: string;
}

function generateCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

async function workerWaitCode(code: string): Promise<{ found: boolean; chatId?: number; from?: string }> {
  const url = (process.env.NOTIFY_WEBHOOK_URL ?? "").replace(/\/notify$/, "/tg-wait");
  if (url === "" || !url.startsWith("https://")) throw new Error("NOTIFY_WEBHOOK_URL не задан — привязка по коду недоступна");
  const token = (process.env.NOTIFY_WEBHOOK_TOKEN ?? "").trim();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token !== "" ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await resp.json()) as { found?: boolean; chatId?: number; from?: string; error?: string };
  if (!resp.ok) throw new Error(`воркер /tg-wait: HTTP ${resp.status}${json.error ? `: ${json.error}` : ""}`);
  return { found: json.found === true, chatId: json.chatId, from: json.from };
}

export class NotifyBinder {
  private codes = new Map<string, PendingCode>();
  private timer: NodeJS.Timeout | null = null;
  private lastErrorLogAt = 0;

  constructor(private readonly config: OrchestraConfig) {}

  /** Выдать одноразовый код для пользователя; биндер сам привяжет chat id, когда юзер отправит код боту. */
  requestCode(user: UserConfig): { code: string; expiresAtMs: number } {
    const now = Date.now();
    for (const [code, pc] of this.codes) {
      if (pc.expiresAt <= now || pc.chatId !== undefined) this.codes.delete(code);
    }
    // не выдаём код, совпадающий с живым
    let code = generateCode();
    while (this.codes.has(code)) code = generateCode();
    this.codes.set(code, { code, userName: user.name, expiresAt: now + CODE_TTL_MS });
    this.ensureLoop();
    log(`notify-bind: код ${code} выдан для «${user.name}» (10 мин)`);
    return { code, expiresAtMs: now + CODE_TTL_MS };
  }

  /** Привязка случилась? (для тулзы, которая хочет подтвердить результат) */
  boundChatId(code: string): number | undefined {
    return this.codes.get(code)?.chatId;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureLoop(): void {
    if (this.timer === null) {
      this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    }
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    for (const pc of [...this.codes.values()]) {
      if (pc.expiresAt <= now) {
        this.codes.delete(pc.code);
        log(`notify-bind: код ${pc.code} истёк (юзер ${pc.userName})`);
        continue;
      }
      try {
        const r = await workerWaitCode(pc.code);
        if (!r.found || r.chatId === undefined) continue;
        pc.chatId = r.chatId;
        pc.fromName = r.from;
        const user = this.config.users.find((u) => u.name === pc.userName);
        if (user) user.chatId = r.chatId;
        persistRegistryState(this.config);
        this.codes.delete(pc.code);
        log(`notify-bind: привязан chat ${r.chatId} (${r.from ?? "?"}) → юзер «${pc.userName}»`);
        void notify(r.chatId, `✅ Telegram привязан к zcode-orchestra (юзер ${pc.userName})\nСюда будут приходить уведомления автоклейма. Проверка: тулза notify_test.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (Date.now() - this.lastErrorLogAt > 60_000) {
          this.lastErrorLogAt = Date.now();
          log(`notify-bind: опрос воркера не удался: ${msg}`);
        }
      }
    }
    if (this.codes.size === 0) this.stop();
  }
}
