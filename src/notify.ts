// notify.ts — отправка уведомлений через CF Worker-релей (worker/notify-worker.js).
// Контейнер НЕ знает токен бота и НЕ ходит в Telegram: он POST'ит {chatId, text}
// на NOTIFY_WEBHOOK_URL с bearer NOTIFY_WEBHOOK_TOKEN; воркер держит TG_BOT_TOKEN
// как секрет и шлёт sendMessage. chat id — свойство юзера (задаётся при настройке MCP).
// Без NOTIFY_WEBHOOK_URL уведомления просто выключены (в лог пишется один раз).
const TG_TEXT_LIMIT = 3900; // лимит Telegram 4096 — с запасом

let warnedNoWebhook = false;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function notificationsEnabled(): boolean {
  return (process.env.NOTIFY_WEBHOOK_URL ?? "").trim() !== "";
}

export interface NotifyResult {
  ok: boolean;
  error?: string;
  /** true — уведомления выключены конфигом (не ошибка) */
  disabled?: boolean;
}

/** POST {chatId, text} на воркер-релей. Не бросает — уведомление не должно ронять тик. */
export async function notify(chatId: number, text: string): Promise<NotifyResult> {
  const url = (process.env.NOTIFY_WEBHOOK_URL ?? "").trim();
  if (url === "") {
    if (!warnedNoWebhook) {
      warnedNoWebhook = true;
      console.error(`[notify] NOTIFY_WEBHOOK_URL не задан — уведомления выключены`);
    }
    return { ok: false, disabled: true };
  }
  const token = (process.env.NOTIFY_WEBHOOK_TOKEN ?? "").trim();
  const body = JSON.stringify({ chatId, text: text.length > TG_TEXT_LIMIT ? `${text.slice(0, TG_TEXT_LIMIT)}…` : text });
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token !== "" ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return { ok: false, error: `вебхук HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Тексты уведомлений автоклейма — в одном месте, чтобы менять тон в одном месте. */
export function claimSuccessText(account: string, planName: string, planId: string, grants: string[], endsAt?: number, startsAt?: number): string {
  const fmt = (ts?: number): string => (ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");
  return [
    `✅ Клейм удался (акк ${account})`,
    `«${planName}» (${planId})`,
    grants.length > 0 ? grants.join("\n") : undefined,
    `Окно: ${[fmt(startsAt), fmt(endsAt)].filter(Boolean).join(" → ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function claimFailText(account: string, planId: string, kind: "denied" | "error", message: string): string {
  const icon = kind === "denied" ? "⚠️" : "❌";
  return `${icon} Клейм ${kind === "denied" ? "отклонён" : "не удался"} (акк ${account})\n${planId}\n${message}`;
}

export function claimBrokenText(account: string, message: string): string {
  return `❌ Автоклейм сломался (акк ${account})\n${message}`;
}
