// notify-bind.ts — привязка Telegram по одноразовым кодам + команды боту.
// notify_code() выдаёт код, юзер отправляет его боту, биндер опрашивает воркер
// (/tg-wait — getUpdates с буфером на его стороне) и привязывает chat id к
// пользователю оркестра. Подтверждение приходит в TG.
// Плюс биндер разбирает слэш-команды от ПРИВЯЗАННЫХ чатов: /status — статус
// аккаунтов в ответ, остальное — подсказка. Чужие чаты игнорируются (их заберёт
// их оркестр); обработанное подтверждается через /tg-ack (воркер удалит сообщение).
// Один бот на все оркестры: буфер в воркере общий, каждый код матчится один раз.
import type { OrchestraConfig, UserConfig } from "./config.js";
import { persistRegistryState } from "./accounts.js";
import type { AccountManager } from "./accounts.js";
import type { ClaimScheduler } from "./claim-scheduler.js";
import { notify } from "./notify.js";
import { accountsStatusText } from "./status-text.js";
import { log } from "./logger.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без 0/O/1/I
const ERROR_LOG_GAP_MS = 60_000;

interface PendingCode {
  code: string;
  userName: string;
  expiresAt: number;
  chatId?: number;
  fromName?: string;
}

interface TgCommand {
  chatId: number;
  messageId: number;
  text: string;
  from?: string;
}

function generateCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

async function workerPoll(code?: string): Promise<{ found: boolean; chatId?: number; from?: string; commands?: TgCommand[] }> {
  const url = (process.env.NOTIFY_WEBHOOK_URL ?? "").replace(/\/notify$/, "/tg-wait");
  if (url === "" || !url.startsWith("https://")) throw new Error("NOTIFY_WEBHOOK_URL не задан — TG-канал недоступен");
  const token = (process.env.NOTIFY_WEBHOOK_TOKEN ?? "").trim();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token !== "" ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(code ? { code } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await resp.json()) as { found?: boolean; chatId?: number; from?: string; commands?: TgCommand[]; error?: string };
  if (!resp.ok) throw new Error(`воркер /tg-wait: HTTP ${resp.status}${json.error ? `: ${json.error}` : ""}`);
  return { found: json.found === true, chatId: json.chatId, from: json.from, commands: json.commands };
}

async function workerAck(cmd: TgCommand): Promise<void> {
  const url = (process.env.NOTIFY_WEBHOOK_URL ?? "").replace(/\/notify$/, "/tg-ack");
  if (url === "" || !url.startsWith("https://")) return;
  const token = (process.env.NOTIFY_WEBHOOK_TOKEN ?? "").trim();
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token !== "" ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ chatId: cmd.chatId, messageId: cmd.messageId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // не критично — буфер воркера сам подчистится по TTL
  }
}

export class NotifyBinder {
  private codes = new Map<string, PendingCode>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastErrorLogAt = 0;

  constructor(
    private readonly config: OrchestraConfig,
    private readonly accounts: AccountManager,
    private readonly scheduler: ClaimScheduler,
  ) {}

  /** Цикл опроса — живёт всегда (коды + команды боту). Без вебхука молчит. */
  start(): void {
    if ((process.env.NOTIFY_WEBHOOK_URL ?? "").trim() === "") {
      log("notify-bind: NOTIFY_WEBHOOK_URL не задан — команды и коды боту выключены");
      return;
    }
    this.ensureLoop();
  }

  /** Выдать одноразовый код для пользователя; биндер сам привяжет chat id, когда юзер отправит код боту. */
  requestCode(user: UserConfig): { code: string; expiresAtMs: number } {
    const now = Date.now();
    for (const [code, pc] of this.codes) {
      if (pc.expiresAt <= now || pc.chatId !== undefined) this.codes.delete(code);
    }
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
    if (this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      for (const [code, pc] of [...this.codes]) {
        if (pc.expiresAt <= now) {
          this.codes.delete(code);
          log(`notify-bind: код ${code} истёк (юзер ${pc.userName})`);
        }
      }
      // один опрос воркера: и код (если есть ожидающий), и команды
      const pending = [...this.codes.values()].find((pc) => pc.chatId === undefined);
      const r = await workerPoll(pending?.code);
      if (pending && r.found && r.chatId !== undefined) {
        pending.chatId = r.chatId;
        pending.fromName = r.from;
        const user = this.config.users.find((u) => u.name === pending.userName);
        if (user) user.chatId = r.chatId;
        persistRegistryState(this.config);
        this.codes.delete(pending.code);
        log(`notify-bind: привязан chat ${r.chatId} (${r.from ?? "?"}) → юзер «${pending.userName}»`);
        void notify(r.chatId, `✅ Telegram привязан к zcode-orchestra (юзер ${pending.userName})\nСюда приходят уведомления автоклейма. Команды: /status — статус аккаунтов.`);
      }
      for (const cmd of r.commands ?? []) {
        await this.handleCommand(cmd);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (Date.now() - this.lastErrorLogAt > ERROR_LOG_GAP_MS) {
        this.lastErrorLogAt = Date.now();
        log(`notify-bind: опрос воркера не удался: ${msg}`);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Слэш-команды от привязанных чатов. Чужой chat id игнорируем (его оркестр сам разберёт). */
  private async handleCommand(cmd: TgCommand): Promise<void> {
    const user = this.config.users.find((u) => u.chatId === cmd.chatId);
    if (user === undefined) return; // чужой чат — не наш клиент
    const text = cmd.text.trim().toLowerCase();
    try {
      if (/^\/(status|статус|account_list|accounts)/.test(text)) {
        const body = await accountsStatusText(this.config, user, this.accounts, this.scheduler);
        await notify(cmd.chatId, body);
      } else {
        await notify(cmd.chatId, "Бот понимает:\n• /status — статус аккаунтов\n• одноразовый код привязки (выдаёт notify_code)");
      }
      await workerAck(cmd);
      log(`notify-bind: команда от chat ${cmd.chatId} (${user.name}): ${cmd.text.slice(0, 40)} — обработана`);
    } catch (e) {
      log(`notify-bind: команда ${cmd.text.slice(0, 40)} не обработана: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
