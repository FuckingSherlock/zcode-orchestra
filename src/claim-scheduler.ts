// claim-scheduler.ts — автоклейм: периодический discovery (events + marketing/touch +
// preview — дёшево, без капчи) и клейм появившихся активностей через claim-cli.
// Окна (18:00 ночные, пт-вечер выходные) НЕ хардкодятся — кандидат появляется в
// touch/preview, планировщик в течение одного тика его клеймить и записывает в state.
// State (data/claim-state.json) переживает рестарты: suppress по endsAt плана,
// бэкоффы по кодам (1005 — слот занят, 1002 — кампания умерла, прочие — 30 мин).
// Уведомления — владельцу аккаунта (юзеру) через CF Worker-релей (notify.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountConfig, OrchestraConfig } from "./config.js";
import { runClaimJson } from "./claim.js";
import { claimBrokenText, claimFailText, claimSuccessText, notify } from "./notify.js";
import { log } from "./logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_ERROR_NOTIFY_GAP_MS = 6 * 60 * 60 * 1000; // не спамим про сломанный discovery чаще 1 раза в 6ч

interface PlanState {
  result: "claimed" | "denied" | "error";
  code?: number;
  /** ends_at плана (грант активен до / NextAt при 1005) — unix seconds */
  endsAt?: number;
  lastAttemptAt: number;
  lastMessage?: string;
  attempts: number;
}

interface AccountClaimState {
  plans: Record<string, PlanState>;
  lastDiscoveryErrorAt?: number;
  lastDiscoveryError?: string;
}

interface ClaimState {
  accounts: Record<string, AccountClaimState>;
}

function emptyAccountState(): AccountClaimState {
  return { plans: {} };
}

/** Стоит ли снова пытаться клеймить этот план. */
function shouldAttempt(s: PlanState | undefined, now: number): boolean {
  if (!s) return true;
  if (s.endsAt !== undefined && now < s.endsAt * 1000) return false; // грант активен / слот занят до endsAt
  if (s.result === "claimed") {
    // успех без endsAt — суточный план без данных: сутки не трогаем
    return now - s.lastAttemptAt >= DAY_MS;
  }
  const backoff = s.code === 1002 ? 7 * DAY_MS : s.code === 1005 ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000;
  return now - s.lastAttemptAt >= backoff;
}

export class ClaimScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly statePath: string;
  private state: ClaimState = { accounts: {} };

  constructor(
    private readonly config: OrchestraConfig,
    private readonly runner: { readonly activeCount: number },
  ) {
    this.statePath = join(config.dataDir, "claim-state.json");
    this.loadState();
  }

  start(): void {
    if (!this.config.claimAuto) {
      log("автоклейм выключен (ORCHESTRA_CLAIM_AUTO=0)");
      return;
    }
    const firstDelay = Math.min(30_000, this.config.claimIntervalMs);
    log(`автоклейм: интервал ${Math.round(this.config.claimIntervalMs / 1000)}с, первый тик через ${Math.round(firstDelay / 1000)}с`);
    this.timer = setTimeout(() => void this.runTick(), firstDelay);
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => void this.runTick(), this.config.claimIntervalMs);
  }

  private async runTick(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      log(`автоклейм: ошибка тика: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.scheduleNext();
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const acc of this.config.accounts) {
        // claim-child получает свои 512МБ heap — не стартуем под полной нагрузкой
        if (this.runner.activeCount >= this.config.maxParallel) {
          log("автоклейм: слоты заняты задачами — тик прерван");
          return;
        }
        await this.tickAccount(acc);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickAccount(acc: AccountConfig): Promise<void> {
    const owner = this.config.users.find((u) => u.accounts.includes("*") || u.accounts.includes(acc.name));
    if (!owner) {
      log(`автоклейм (${acc.name}): нет пользователя-владельца — пропуск`);
      return;
    }
    const accState = this.state.accounts[acc.name] ?? emptyAccountState();

    // 1. discovery — spawn claim-cli --discover (events + touch + preview, без минта)
    const run = await runClaimJson(this.config, undefined, acc.name, undefined, "discover");
    const outcome = run.outcome;
    if (!outcome || !outcome.ok) {
      const msg = outcome?.error ?? run.spawnError ?? `exit ${run.exitCode}: ${run.stderrTail.slice(-200)}`;
      log(`автоклейм (${acc.name}): discovery не удался: ${msg}`);
      const last = accState.lastDiscoveryErrorAt ?? 0;
      if (Date.now() - last > DISCOVERY_ERROR_NOTIFY_GAP_MS) {
        accState.lastDiscoveryErrorAt = Date.now();
        accState.lastDiscoveryError = msg;
        this.saveState();
        const chat = acc.notifyChatId ?? owner.chatId;
        if (chat !== undefined) await notify(chat, claimBrokenText(acc.name, msg));
      }
      return;
    }
    if (accState.lastDiscoveryErrorAt !== undefined) {
      accState.lastDiscoveryErrorAt = undefined;
      accState.lastDiscoveryError = undefined;
    }

    // 2. кандидаты: union(preview, touch); приоритет — из preview
    const preview = outcome.plans ?? [];
    const priorities = new Map<string, number>(preview.map((p) => [p.planId, p.priority]));
    const names = new Map<string, string>(preview.map((p) => [p.planId, p.name]));
    const candidates = new Set<string>([...preview.map((p) => p.planId), ...(outcome.campaignPlanIds ?? [])]);

    // 3. фильтр по state (suppress/бэкофф)
    const now = Date.now();
    const due = [...candidates].filter((id) => shouldAttempt(accState.plans[id], now));
    log(
      `автоклейм (${acc.name}): preview=${preview.length}, кампаний=${outcome.campaignPlanIds?.length ?? 0}, ` +
        `кандидатов=${candidates.size}, к клейму=${due.length ? due.join(",") : 0}`,
    );
    if (due.length === 0) return;

    // 4. выбор: приоритет preview desc; неизвестные — последними
    due.sort((a, b) => (priorities.get(b) ?? -1) - (priorities.get(a) ?? -1));
    const planId = due[0] as string;

    // 5. клейм (spawn claim-cli --claim <planId>)
    const claimRun = await runClaimJson(this.config, undefined, acc.name, planId, "claim");
    const c = claimRun.outcome?.claim;
    const rec: PlanState = {
      result: c?.result ?? "error",
      code: c?.code,
      ...(c?.endsAt !== undefined ? { endsAt: c.endsAt } : {}),
      lastAttemptAt: Date.now(),
      lastMessage: c?.message ?? claimRun.outcome?.error ?? (c ? undefined : `claim-cli exit ${claimRun.exitCode}: ${claimRun.stderrTail.slice(-200)}`),
      attempts: (accState.plans[planId]?.attempts ?? 0) + 1,
    };
    accState.plans[planId] = rec;
    this.state.accounts[acc.name] = accState;
    this.saveState();
    log(`автоклейм (${acc.name}): ${planId} → ${rec.result}${rec.code !== undefined ? ` (код ${rec.code})` : ""}${rec.lastMessage ? `: ${rec.lastMessage.slice(0, 200)}` : ""}`);

    // 6. уведомление владельцу
    const chat = acc.notifyChatId ?? owner.chatId;
    if (chat === undefined) {
      log(`автоклейм (${acc.name}): chat id не задан (user.chatId/account.notifyChatId) — уведомление пропущено`);
      return;
    }
    if (rec.result === "claimed" && claimRun.outcome?.claim) {
      const cl = claimRun.outcome.claim;
      await notify(chat, claimSuccessText(acc.name, cl.planName ?? names.get(planId) ?? planId, planId, cl.grants ?? [], cl.endsAt, cl.startsAt));
    } else {
      await notify(chat, claimFailText(acc.name, planId, rec.result === "denied" ? "denied" : "error", rec.lastMessage ?? "(без сообщения)"));
    }
  }

  private loadState(): void {
    try {
      if (!existsSync(this.statePath)) return;
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.state = parsed as ClaimState;
      }
    } catch (e) {
      log(`автоклейм: state не прочитан (${e instanceof Error ? e.message : String(e)}) — начинаю с пустого`);
    }
  }

  private saveState(): void {
    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 1));
    } catch (e) {
      log(`автоклейм: state не сохранён: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
