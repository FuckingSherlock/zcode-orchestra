// Единая точка логирования: всегда stderr.
// В stdio-режиме stdout занят MCP-протоколом — писать туда нельзя.
export function log(msg: string): void {
  console.error(`[orchestra ${new Date().toISOString()}] ${msg}`);
}
