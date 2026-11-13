// accounts.ts — рантайм-управление аккаунтами zcode через MCP:
//   account_add   — создаёт аккаунт и запускает OAuth-логин (ссылка отдаётся юзеру);
//   login_status  — авторизован ли аккаунт / крутится ли логин;
//   account_remove— удалить аккаунт (директория, реестр, claim-state);
//   notify_setup  — сменить Telegram chat id (юзера или конкретного аккаунта).
// Динамические аккаунты живут в <dataDir>/accounts/<name>/ (изолированный HOME —
// creds/telemetry не мешают общим) и регистрируются в <dataDir>/registry.json,
// который loadConfig накладывает поверх статического конфига при старте.
// Секрет шифрования кредов общий (ZCODE_CREDENTIAL_SECRET_FILE контейнера).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { OrchestraConfig, UserConfig } from "./config.js";
import { log } from "./logger.js";

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const URL_WAIT_MS = 20_000;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

export interface LoginSnapshot {
  authorized: boolean;
  loginRunning: boolean;
  url?: string;
}

export class AccountManager {
  private logins = new Map<string, { child: ChildProcess; startedAt: number; url?: string; lastError?: string }>();

  accountDir(config: OrchestraConfig, name: string): string {
    return join(resolve(config.dataDir), "accounts", name);
  }

  credentialsPath(config: OrchestraConfig, name: string): string {
    // HOME аккаунта = accountDir → дефолтный путь CLI; ZCODE_CLI_CREDENTIALS_FILE указывает туда же явно
    return join(this.accountDir(config, name), ".zcode", "v2", "credentials.json");
  }

  isRuntimeAccount(config: OrchestraConfig, name: string): boolean {
    const acc = config.accounts.find((a) => a.name === name);
    if (!acc?.credentialsFile) return false;
    return resolve(acc.credentialsFile).startsWith(join(resolve(config.dataDir), "accounts") + sep);
  }

  authorized(config: OrchestraConfig, name: string): boolean {
    try {
      const p = this.credentialsPath(config, name);
      return existsSync(p) && readFileSync(p, "utf8").trim().length > 10;
    } catch {
      return false;
    }
  }

  loginSnapshot(config: OrchestraConfig, name: string): LoginSnapshot {
    const login = this.logins.get(name);
    return {
      authorized: this.authorized(config, name),
      loginRunning: login !== undefined,
      ...(login?.url !== undefined ? { url: login.url } : {}),
    };
  }

  /**
   * Создать (при необходимости) аккаунт и запустить OAuth-логин. Если аккаунт уже
   * авторизован — перезапуск не нужен. Повторный вызов убивает старый логин и
   * выдаёт свежую ссылку (ссылки одноразовые и быстро протухают).
   * Возвращает url (ждём его из stdout до URL_WAIT_MS) или undefined.
   */
  async startLogin(config: OrchestraConfig, user: UserConfig, name: string, model?: string): Promise<{ url?: string; alreadyAuthorized: boolean }> {
    if (!NAME_RE.test(name)) throw new Error(`имя аккаунта «${name}» не подходит: буквы/цифры/-/_ до 32 символов`);
    if (this.authorized(config, name)) return { alreadyAuthorized: true };

    const acc = config.accounts.find((a) => a.name === name);
    if (!acc) {
      const credsPath = this.credentialsPath(config, name);
      config.accounts.push({
        name,
        credentialsFile: credsPath,
        providerConfigFile: null,
        model: model && model.trim() !== "" ? model.trim() : "account:zai-start-plan/GLM-5.3-Flash",
      });
      if (!user.accounts.includes("*") && !user.accounts.includes(name)) user.accounts.push(name);
      this.persistRegistry(config);
      log(`аккаунт «${name}» создан (владелец ${user.name})`);
    } else if (!acc.credentialsFile) {
      throw new Error(`аккаунт «${name}» статический без credentialsFile — его логинят вручную через docker exec`);
    }

    // старый логин — убить (ссылка от него уже невалидна)
    const old = this.logins.get(name);
    if (old) {
      try {
        old.child.kill("SIGKILL");
      } catch {
        // уже мёртв
      }
      this.logins.delete(name);
    }

    const accDir = this.accountDir(config, name);
    mkdirSync(accDir, { recursive: true });
    const credsPath = this.credentialsPath(config, name);
    mkdirSync(dirname(credsPath), { recursive: true });

    const child = spawn(config.zcodeBin, ["login", "--oauth", "--no-browser"], {
      env: { ...process.env, HOME: accDir, ZCODE_CLI_CREDENTIALS_FILE: credsPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entry = { child, startedAt: Date.now(), url: undefined as string | undefined, lastError: undefined as string | undefined };
    this.logins.set(name, entry);
    const onOutput = (buf: Buffer): void => {
      const text = buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, ""); // ANSI-коды долой
      if (entry.url === undefined) {
        const m = /https?:\/\/\S+/.exec(text);
        if (m) entry.url = m[0].replace(/[)"'`].*$/, "");
      }
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", (buf: Buffer) => {
      onOutput(buf);
      const text = buf.toString("utf8");
      if (text.trim() !== "") entry.lastError = text.trim().slice(0, 400);
    });
    child.on("close", (code) => {
      if (this.logins.get(name) === entry) {
        this.logins.delete(name);
        log(`логин «${name}» завершён (exit ${code ?? "?"}${entry.url ? ", ссылка была выдана" : ""})`);
      }
    });
    const timer = setTimeout(() => {
      if (this.logins.get(name) === entry) {
        try {
          child.kill("SIGKILL");
        } catch {
          // уже мёртв
        }
      }
    }, LOGIN_TIMEOUT_MS);
    timer.unref();

    // ждём появления ссылки в выводе CLI
    const deadline = Date.now() + URL_WAIT_MS;
    while (entry.url === undefined && Date.now() < deadline && this.logins.get(name) === entry) {
      await new Promise((r) => setTimeout(r, 300));
    }
    return { url: entry.url, alreadyAuthorized: false };
  }

  /** Удалить рантаймный аккаунт: логин, директория, config, реестр, claim-state. */
  removeAccount(config: OrchestraConfig, user: UserConfig, name: string): void {
    if (!NAME_RE.test(name)) throw new Error(`неверное имя аккаунта «${name}»`);
    if (!this.isRuntimeAccount(config, name)) {
      throw new Error(`аккаунт «${name}» не рантаймный (создан в ORCHESTRA_ACCOUNTS) — удаляется через конфиг и рестарт`);
    }
    const acc = config.accounts.find((a) => a.name === name);
    if (acc && user.accounts.includes("*") === false && !user.accounts.includes(name)) {
      throw new Error(`аккаунт «${name}» вам недоступен`);
    }
    const login = this.logins.get(name);
    if (login) {
      try {
        login.child.kill("SIGKILL");
      } catch {
        // уже мёртв
      }
      this.logins.delete(name);
    }
    config.accounts = config.accounts.filter((a) => a.name !== name);
    if (!user.accounts.includes("*")) user.accounts = user.accounts.filter((a) => a !== name);
    try {
      rmSync(this.accountDir(config, name), { recursive: true, force: true });
    } catch (e) {
      log(`аккаунт «${name}»: директория не удалена: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.persistRegistry(config);
    this.dropClaimState(config, name);
    log(`аккаунт «${name}» удалён (владелец ${user.name})`);
  }

  /** Смена Telegram chat id: аккаунта (accountName задан) или юзера. */
  setNotifyChatId(config: OrchestraConfig, user: UserConfig, chatId: number, accountName?: string): { target: string } {
    if (!Number.isInteger(chatId) || chatId <= 0) throw new Error(`chat id должен быть положительным целым, получено «${chatId}»`);
    if (accountName && accountName.trim() !== "") {
      const acc = config.accounts.find((a) => a.name === accountName.trim());
      if (!acc) throw new Error(`аккаунт «${accountName}» не найден`);
      acc.notifyChatId = chatId;
      this.persistRegistry(config);
      return { target: `аккаунт ${acc.name}` };
    }
    user.chatId = chatId;
    this.persistRegistry(config);
    return { target: `пользователь ${user.name}` };
  }

  /** Запись runtime-состояния в <dataDir>/registry.json (читается loadConfig'ом при старте). */
  persistRegistry(config: OrchestraConfig): void {
    const runtimePrefix = join(resolve(config.dataDir), "accounts") + sep;
    const registry = {
      accounts: config.accounts
        .filter((a) => a.credentialsFile !== null && resolve(a.credentialsFile).startsWith(runtimePrefix))
        .map((a) => ({
          name: a.name,
          credentialsFile: a.credentialsFile,
          model: a.model,
          ...(a.notifyChatId !== undefined ? { notifyChatId: a.notifyChatId } : {}),
        })),
      userChatIds: Object.fromEntries(config.users.filter((u) => u.chatId !== undefined).map((u) => [u.name, u.chatId as number])),
      userAccounts: Object.fromEntries(config.users.filter((u) => !u.accounts.includes("*")).map((u) => [u.name, u.accounts])),
    };
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(join(config.dataDir, "registry.json"), JSON.stringify(registry, null, 1));
    } catch (e) {
      log(`реестр не записан: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Зачистить claim-state удалённого аккаунта (best effort). */
  private dropClaimState(config: OrchestraConfig, name: string): void {
    try {
      const p = join(config.dataDir, "claim-state.json");
      if (!existsSync(p)) return;
      const state = JSON.parse(readFileSync(p, "utf8")) as { accounts?: Record<string, unknown> };
      if (state.accounts && name in state.accounts) {
        delete state.accounts[name];
        writeFileSync(p, JSON.stringify(state, null, 1));
      }
    } catch {
      // не критично
    }
  }
}
