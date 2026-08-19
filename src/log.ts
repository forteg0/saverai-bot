/**
 * Logging del bot.
 *
 * Por defecto imprime lineas limpias (una por gasto). Con BOT_DEBUG=1 se activan
 * las lineas paso a paso, utiles para diagnosticar el webhook.
 */

let debugEnabled = false

/** Se llama una vez al arrancar, con config.debug. */
export function setDebug(value: boolean) {
  debugEnabled = value
}

function stamp() {
  return new Date().toISOString().slice(11, 19) // HH:MM:SS
}

/** Linea principal, siempre visible. */
export function info(message: string) {
  console.log(`${stamp()} ${message}`)
}

/** Solo con BOT_DEBUG=1. */
export function debug(message: string) {
  if (debugEnabled) console.log(`${stamp()}   · ${message}`)
}

export function warn(message: string) {
  console.warn(`${stamp()} ⚠ ${message}`)
}

export function error(message: string, err?: unknown) {
  const detail = err instanceof Error ? err.message : err ? String(err) : ""
  console.error(`${stamp()} ✖ ${message}${detail ? ` — ${detail}` : ""}`)
}
