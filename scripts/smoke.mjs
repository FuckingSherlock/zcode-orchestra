#!/usr/bin/env node
// Смоук-тест runner'а без реального zcode:
//   fake-zcode.mjs (echo-заглушка) → submit → статус → done → проверка журнала.
// Запуск: npm run smoke (требует предварительно npm run build).
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "orchestra-smoke-"));

// окружение для runner'а: фейковый CLI вместо настоящего zcode
process.env.ORCHESTRA_ZCODE_BIN = path.join(root, "test", "fake-zcode.mjs");
process.env.ORCHESTRA_DATA_DIR = dataDir;
process.env.ORCHESTRA_MAX_PARALLEL = "2";
// runner транспортно-агностичен; stdio — чтобы не требовать bearer-токен
process.env.ORCHESTRA_TRANSPORT = "stdio";

const { loadConfig } = await import(pathToFileURL(path.join(root, "dist", "config.js")).href);
const { Runner } = await import(pathToFileURL(path.join(root, "dist", "runner.js")).href);

const config = loadConfig(process.env);
const runner = new Runner(config);

const workdir = path.join(dataDir, "work");
const { jobId, position } = runner.submit({
  brief: "smoke: проверить очередь, спавн и разбор результата",
  workdir,
});
console.log(`submit: jobId=${jobId} status=${runner.list(1)[0]?.status} position=${position}`);

const rec = await runner.waitFor(jobId, 30_000);
await runner.flushJournal(); // журнал пишется асинхронно — дожидаемся записи
console.log("финальный статус задачи:");
console.log(JSON.stringify(rec, null, 2));

const failures = [];
if (rec.status !== "done") failures.push(`status: ожидался done, получен ${rec.status}`);
if (!(rec.result ?? "").startsWith("smoke-ok:")) failures.push(`result: не начинается с smoke-ok: ${rec.result}`);
if (!(rec.sessionId ?? "").startsWith("fake-")) failures.push(`sessionId: ожидание fake-..., получено ${rec.sessionId}`);
if (rec.usage?.input_tokens !== 11) failures.push(`usage: не распарсен из JSON (${JSON.stringify(rec.usage)})`);
if (rec.exitCode !== 0) failures.push(`exitCode: ожидался 0, получен ${rec.exitCode}`);
if (!existsSync(path.join(dataDir, "jobs", `${jobId}.log`))) failures.push("лог-файл задачи не создан");

// журнал обязан переживать доступ: jobs.json содержит задачу со статусом done
const journal = JSON.parse(readFileSync(path.join(dataDir, "jobs.json"), "utf8"));
if (journal.jobs?.[jobId]?.status !== "done") failures.push("jobs.json не содержит задачу со статусом done");

if (failures.length > 0) {
  console.error("SMOKE FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK: submit → queued/running → done; result/session_id/usage распарсены; журнал записан (${dataDir})`);
