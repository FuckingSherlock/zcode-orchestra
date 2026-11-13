// CF Worker — релей уведомлений zcode-orchestra → Telegram.
// Оркестр (или любой клиент) POST'ит {chatId, text}; воркер держит токен бота
// как секрет и шлёт sendMessage. Никакого состояния.
//
// Деплой (dash.cloudflare.com → Workers → Create → вставить этот файл), затем:
//   Settings → Variables → Secret: TG_BOT_TOKEN = <токен от @BotFather>
//   Settings → Variables → Secret: AUTH_TOKEN   = <длинная случайная строка>
// В .env оркестра:
//   NOTIFY_WEBHOOK_URL=https://<worker>.<subdomain>.workers.dev/notify
//   NOTIFY_WEBHOOK_TOKEN=<тот же AUTH_TOKEN>

const TG_TEXT_LIMIT = 4096;

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
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
