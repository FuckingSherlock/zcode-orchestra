// claim-cli.ts — standalone-процесс клейма (spawn из src/claim.ts, либо руками):
//   node dist/claim-cli.js --credentials /root/.zcode/v2/credentials.json [--claim [PLAN_ID]] [--status]
// Отдельный процесс нужен, чтобы happy-dom-минт капчи не делил heap с сервером
// (у сервера NODE_OPTIONS --max-old-space-size=224; минту выделяем свои 512МБ).
// Результат — ОДНА строка JSON в stdout (парсит src/claim.ts); человекочитаемый
// прогресс — в stderr. --mint-only не требует кредов: смоук вендоред-солвера.
import { runPipeline } from "./claim/client.js";

interface CliArgs {
  credentials?: string;
  secretFile?: string;
  secretInline?: string;
  claimPlanId?: string; // "" = авто-выбор (высший приоритет preview)
  doClaim: boolean;
  doStatus: boolean;
  mintOnly: boolean;
  appVersion: string;
  platform?: string;
  lang: string;
  mintAttempts?: number;
  claimAttempts?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { doClaim: false, doStatus: false, mintOnly: false, appVersion: "3.18.1", lang: "ru-RU" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const next = argv[i + 1];
    const nextIsValue = next !== undefined && !next.startsWith("--");
    switch (a) {
      case "--credentials": args.credentials = nextIsValue ? argv[++i] : undefined; break;
      case "--secret-file": args.secretFile = nextIsValue ? argv[++i] : undefined; break;
      case "--secret": args.secretInline = nextIsValue ? argv[++i] : undefined; break;
      case "--claim":
        args.doClaim = true;
        if (nextIsValue) args.claimPlanId = argv[++i];
        break;
      case "--status": args.doStatus = true; break;
      case "--mint-only": args.mintOnly = true; break;
      case "--app-version": if (nextIsValue) args.appVersion = argv[++i] ?? args.appVersion; break;
      case "--platform": if (nextIsValue) args.platform = argv[++i]; break;
      case "--lang": if (nextIsValue) args.lang = argv[++i] ?? args.lang; break;
      case "--mint-attempts": if (nextIsValue) args.mintAttempts = Number(argv[++i]) || undefined; break;
      case "--claim-attempts": if (nextIsValue) args.claimAttempts = Number(argv[++i]) || undefined; break;
      default: break; // незнакомые флаги игнорируем (совместимость)
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const log = (line: string): void => console.error(line);

const action = args.mintOnly ? "mint-only" : args.doClaim ? "claim" : "status";
const platform = args.platform ?? (process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-arm64" : "linux-x64");

try {
  const outcome = await runPipeline({
    action,
    credentialsPath: args.credentials,
    secretFile: args.secretFile,
    secretInline: args.secretInline,
    planId: args.claimPlanId,
    appVersion: args.appVersion,
    platform,
    lang: args.lang,
    mintAttempts: args.mintAttempts,
    claimAttempts: args.claimAttempts,
    log,
  });
  console.log(JSON.stringify(outcome));
  // happy-dom/worker-threads держат event loop после решения — выходим явно,
  // иначе spawn из claim.ts висит до таймаута
  process.exit(outcome.ok ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify({ ok: false, action, appVersion: args.appVersion, platform, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
}
