#!/usr/bin/env node
// Эхо-заглушка zcode CLI для смоук-тестов runner'а: печатает шум + финальный JSON, exit 0.
// Формат эмулирует `zcode -p <brief> --output-format json` (result/session_id/usage).
const argv = process.argv.slice(2);
const pIdx = argv.indexOf("-p");
const brief = pIdx >= 0 && pIdx + 1 < argv.length ? argv[pIdx + 1] : "";
const payload = {
  result: `smoke-ok: ${brief}`,
  session_id: `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
};
// шум до JSON — проверка толерантного парсинга хвоста stdout
console.log(`fake-zcode: brief="${brief}" (шум перед финальным JSON)`);
console.log(JSON.stringify(payload));
process.exit(0);
