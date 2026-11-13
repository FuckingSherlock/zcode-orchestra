// CF Worker — релей уведомлений zcode-orchestra → Telegram.
// Оркестр (или любой клиент) POST'ит {chatId, text}; воркер держит токен бота
// как секрет и шлёт sendMessage. Плюс /tg-wait — привязка юзеров по одноразовым
// кодам: оркестр генерит код, юзер отправляет его боту, оркестр опрашивает
// /tg-wait {code} и получает chat_id (узнавать свой id вручную не нужно).
// Никакого состояния на диске: буфер последних апдейтов — в памяти изолята.
//
// Деплой (dash.cloudflare.com → Workers → Create → вставить этот файл), затем:
//   Settings → Variables → Secret: TG_BOT_TOKEN = <токен от @BotFather>
//   Settings → Variables → Secret: AUTH_TOKEN   = <длинная случайная строка>
// В .env оркестра:
//   NOTIFY_WEBHOOK_URL=https://<worker>.<subdomain>.workers.dev/notify
//   NOTIFY_WEBHOOK_TOKEN=<тот же AUTH_TOKEN>

const TG_TEXT_LIMIT = 4096;
const TG_BUFFER_TTL_MS = 15 * 60 * 1000; // сколько держим неподхваченные сообщения
const TG_BUFFER_CAP = 200;

// Память изолята: переживает запросы, но НЕ гарантированно живёт долго и не
// шарится между изолятами. Ок для буфера кодов: оркестр опрашивает каждые 5с,
// редкий сброс буфера просто откладывает привязку на следующий тик.
let tgBuf = [];
let tgOffset = 0;

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Обновить буфер из getUpdates и поискать код.
 * getUpdates подтверждает апдейты офсетом, поэтому неподхваченное для ОДНОГО
 * оркестра сообщение остаётся в буфере и ждёт своего кода (бот один на всех).
 */
async function tgWaitForCode(env, code) {
  const now = Date.now();
  tgBuf = tgBuf.filter((m) => now - m.at < TG_BUFFER_TTL_MS);
  try {
    const u = new URL(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getUpdates`);
    if (tgOffset > 0) u.searchParams.set("offset", String(tgOffset));
    u.searchParams.set("timeout", "0");
    u.searchParams.set("allowed_updates", JSON.stringify(["message"]));
    const resp = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    const j = await resp.json();
    if (j.ok) {
      for (const up of j.result ?? []) {
        tgOffset = Math.max(tgOffset, up.update_id + 1);
        const msg = up.message;
        if (msg && typeof msg.text === "string" && msg.chat) {
          tgBuf.push({
            at: now,
            chatId: msg.chat.id,
            messageId: msg.message_id,
            text: msg.text,
            from: msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name ?? ""),
          });
        }
      }
    }
  } catch {
    // сеть/409 от параллельного getUpdates — код останется в буфере, следующий тик добьёт
  }
  tgBuf = tgBuf.slice(-TG_BUFFER_CAP);
  const norm = String(code).toUpperCase();
  const idx = tgBuf.findIndex((m) => m.text.toUpperCase().includes(norm));
  if (idx === -1) return { found: false };
  const m = tgBuf[idx];
  tgBuf.splice(idx, 1);
  // лучшее усилие: стереть сообщение с кодом из чата (боты умеют удалять в ЛС)
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: m.chatId, message_id: m.messageId }),
    });
  } catch {
    // не критично
  }
  return { found: true, chatId: m.chatId, from: m.from };
}

export default {
  async fetch(request, env) {
    // healthcheck
    if (request.method === "GET" && new URL(request.url).pathname === "/healthz") {
      return jsonResp({ ok: true });
    }
    if (request.method !== "POST") {
      return jsonResp({ ok: false, error: "POST only" }, 405);
    }
    // shared-secret авторизация (constant-time не критична: секрет длинный, канал TLS)
    const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.AUTH_TOKEN || auth !== env.AUTH_TOKEN) {
      return jsonResp({ ok: false, error: "unauthorized" }, 401);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResp({ ok: false, error: "invalid JSON" }, 400);
    }

    const path = new URL(request.url).pathname;

    // привязка по одноразовому коду: {code} → {found, chatId?, from?}
    if (path === "/tg-wait") {
      if (!body.code || typeof body.code !== "string") {
        return jsonResp({ ok: false, error: "code required" }, 400);
      }
      if (!env.TG_BOT_TOKEN) {
        return jsonResp({ ok: false, error: "TG_BOT_TOKEN not configured" }, 500);
      }
      return jsonResp(await tgWaitForCode(env, body.code));
    }

    // отправка уведомления: {chatId, text} → sendMessage
    const chatId = body.chatId;
    const text = typeof body.text === "string" ? body.text.slice(0, TG_TEXT_LIMIT) : "";
    if (!chatId || !text) {
      return jsonResp({ ok: false, error: "chatId and text required" }, 400);
    }
    if (!env.TG_BOT_TOKEN) {
      return jsonResp({ ok: false, error: "TG_BOT_TOKEN not configured" }, 500);
    }
    const tg = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
    });
    const result = await tg.text();
    return new Response(result, { status: tg.status, headers: { "Content-Type": "application/json" } });
  },
};
