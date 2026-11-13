// status-text.ts — человекочитаемый статус аккаунтов для Telegram (/status боту).
// Те же данные, что account_list (MCP отдаёт их JSON'ом), но плоским текстом.
import type { OrchestraConfig, UserConfig } from "./config.js";
import type { AccountManager } from "./accounts.js";
import type { ClaimScheduler } from "./claim-scheduler.js";

function fmtUnix(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const RESULT_ICON: Record<string, string> = { claimed: "✅", denied: "⚠️", error: "❌" };

export async function accountsStatusText(
  config: OrchestraConfig,
  user: UserConfig,
  accounts: AccountManager,
  scheduler: ClaimScheduler,
): Promise<string> {
  const allowed = new Set(user.accounts.includes("*") ? config.accounts.map((a) => a.name) : user.accounts);
  const mine = config.accounts.filter((a) => allowed.has(a.name));
  const lines: string[] = [`📊 zcode-orchestra — юзер ${user.name}`];
  if (mine.length === 0) {
    lines.push("Аккаунтов нет — account_add через нейронку.");
  }
  for (const acc of mine) {
    const whoami = await accounts.whoamiFor(config, acc.name).catch(() => null);
    const zai = whoami?.label ? ` — ${whoami.label}` : whoami?.id ? ` — user_id ${whoami.id}` : "";
    const auth = accounts.authorized(config, acc.name) ? "" : " — ⛔ НЕ авторизован (логин не завершён)";
    lines.push(`\n• ${acc.name}${zai}${auth}`);

    const st = scheduler.accountClaimState(acc.name);
    const plans = Object.entries(st?.plans ?? {});
    if (st?.lastDiscoveryError) {
      lines.push(`  ⚠️ discovery: ${st.lastDiscoveryError.slice(0, 150)}`);
    }
    if (plans.length === 0) {
      if (!st?.lastDiscoveryError) lines.push("  клеймов пока не было");
      continue;
    }
    for (const [planId, s] of plans) {
      const icon = RESULT_ICON[s.result] ?? "•";
      const until = s.endsAt ? `, до ${fmtUnix(s.endsAt)}` : "";
      const msg = s.lastMessage ? ` — ${s.lastMessage.slice(0, 120)}` : "";
      lines.push(`  ${icon} ${planId}: ${s.result}${until} (${s.attempts} поп.)${msg}`);
    }
  }
  return lines.join("\n");
}
