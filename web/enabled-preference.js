/** Explicit per-browser opt-in. Absence means prediction stays off. */
export const KEY = 'dsh-input-predict:enabled'
const COOKIE = 'dsh_input_predict_enabled'

export function browserStorage() {
  try { return globalThis.window?.localStorage ?? null } catch { return null }
}

/** Cookies are keyed by host, not port, so the opt-in survives a Desktop restart. */
function readCookie() {
  try {
    const cookie = globalThis.document?.cookie
    if (typeof cookie !== 'string') return null
    const rows = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`))
    const row = rows.at(-1)
    return row === undefined ? null : row.slice(COOKIE.length + 1)
  } catch { return null }
}

function writeCookie(enabled) {
  try {
    if (globalThis.document === undefined) return
    globalThis.document.cookie = `${COOKIE}=${enabled ? '1' : '0'}; path=/; max-age=31536000; SameSite=Lax`
  } catch { /* cookies unavailable: session-only */ }
}

/**
 * @param {Storage | null | undefined} storage - browser preference storage.
 * @returns whether the user previously enabled prediction.
 */
export function readEnabled(storage = browserStorage()) {
  try {
    const stored = storage?.getItem(KEY)
    if (stored === '1' || stored === '0') return stored === '1'
  } catch { /* fall through to the cross-port cookie */ }
  return readCookie() === '1'
}

/**
 * @param {Storage | null | undefined} storage - browser preference storage.
 * @param {boolean} enabled - explicit user choice.
 */
export function writeEnabled(storage, enabled) {
  try { storage?.setItem(KEY, enabled ? '1' : '0') } catch { /* private mode: session-only */ }
  writeCookie(enabled)
}
