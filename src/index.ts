// Точка входа zcode-orchestra: конфиг → runner → автоклейм-планировщик → MCP-сервер на http или stdio транспорте.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, resolveUser, type OrchestraConfig, type UserConfig } from "./config.js";
import { Runner } from "./runner.js";
import { ClaimScheduler } from "./claim-scheduler.js";
import { AccountManager } from "./accounts.js";
import { registerTools } from "./tools.js";
import { log } from "./logger.js";

const NAME = "zcode-orchestra";
const VERSION = "1.2.0";
const BODY_LIMIT = 10 * 1024 * 1024; // 10 МБ на JSON-RPC запрос

function createMcpServer(config: OrchestraConfig, runner: Runner, user: UserConfig, accounts: AccountManager): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });
  registerTools(server, runner, config, user, accounts);
  return server;
}

function bearerToken(req: http.IncomingMessage): string {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return m?.[1]?.trim() ?? "";
}

/** Bearer-токен → пользователь MCP (constant-time); /healthz проходит мимо этой проверки. */
function checkAuth(req: http.IncomingMessage, config: OrchestraConfig): boolean {
  return resolveUser(config, bearerToken(req)) !== null;
}

function readBody(req: http.IncomingMessage): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON: ${(e as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Stateless-режим streamable HTTP: на каждый POST /mcp — своя пара transport+server
 * (легковесно, сессии в памяти не копятся — важно при 1.9 ГБ RAM на хосте).
 */
async function handleMcpPost(config: OrchestraConfig, runner: Runner, user: UserConfig, accounts: AccountManager, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${(e as Error).message}` } }),
    );
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createMcpServer(config, runner, user, accounts);
  res.on("close", () => {
    void server.close();
    void transport.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function createHttpServer(config: OrchestraConfig, runner: Runner, accounts: AccountManager): http.Server {
  const server = http.createServer((req, res) => {
    void handleHttp(config, runner, accounts, req, res).catch((e) => {
      log(`ошибка обработки запроса: ${(e as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ ok: false, error: "internal error" }));
    });
  });
  // wait=true держит соединение открытым до 30 минут — глобальные таймауты рвут ожидание
  server.requestTimeout = 0; // отключаем таймаут приёма запроса (дефолт 300с)
  server.headersTimeout = 60_000; // заголовки обязаны прийти быстро
  server.keepAliveTimeout = 72_000; // keep-alive выше дефолтных 5с (за прокси/балансировщики)
  server.timeout = 0; // без сокет-таймаута на медленные ответы тулз
  return server;
}

async function handleHttp(
  config: OrchestraConfig,
  runner: Runner,
  accounts: AccountManager,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // healthcheck — без авторизации
  if (pathname === "/healthz") {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: VERSION }));
    return;
  }

  if (pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
    return;
  }

  if (!checkAuth(req, config)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }

  // POST — JSON-RPC. GET (server-initiated SSE) и DELETE (закрытие сессии) в stateless-режиме
  // не поддерживаем намеренно: транспорт открыл бы вечный SSE-поток (утечка соединений),
  // а 405 для stateless-сервера допустим по спецификации MCP.
  if (req.method === "POST") {
    await handleMcpPost(config, runner, resolveUser(config, bearerToken(req)) as UserConfig, accounts, req, res);
  } else {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }));
  }
}

async function main(): Promise<void> {
  let config: OrchestraConfig;
  try {
    config = loadConfig();
  } catch (e) {
    log(`фатально: ${(e as Error).message}`);
    process.exit(1);
  }

  const runner = new Runner(config); // поднимает dataDir и подгружает jobs.json
  const accounts = new AccountManager();
  const scheduler = new ClaimScheduler(config, runner);
  scheduler.start();
  log(`транспорт: ${config.transport}, порт ${config.port}, параллелизм ${config.maxParallel}, аккаунты: ${config.accounts.map((a) => a.name).join(", ")}`);
  log(`пользователи: ${config.users.map((u) => `${u.name}(${u.accounts.join("/")}${u.chatId ? `, tg:${u.chatId}` : ""})`).join(", ")}`);
  log(`данные: ${config.dataDir}, zcode: ${config.zcodeBin}, workdir root: ${config.workdirRoot}`);

  process.on("unhandledRejection", (reason) => {
    log(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`получен ${signal}, останавливаюсь...`);
    scheduler.stop();
    const forceExit = setTimeout(() => process.exit(0), 15_000);
    forceExit.unref();
    void runner
      .shutdown() // queued → cancelled, running → SIGTERM (SIGKILL через 10с)
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (config.transport === "stdio") {
    const server = createMcpServer(config, runner, config.users[0] as UserConfig, accounts);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("stdio-транспорт готов (MCP по stdin/stdout)");
  } else {
    const httpServer = createHttpServer(config, runner, accounts);
    httpServer.listen(config.port, "0.0.0.0", () => {
      log(`http-транспорт готов: http://0.0.0.0:${config.port}/mcp (healthz: /healthz)`);
    });
  }
}

void main();
