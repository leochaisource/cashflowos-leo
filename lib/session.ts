import crypto from 'crypto'

// The passcode gate's one question: has this visitor unlocked the app? Used by
// proxy.ts (every gated page) and the root layout (which also wraps /login, a
// path the gate never sees, and must not show the sidebar's client names there).
export const SESSION_COOKIE = 'cfo_session'

// /api/login mints the cookie as `nonce.HMAC(nonce)`, signed with APP_PASSCODE.
// Checking only that a cookie EXISTED let any made-up value in (found live on
// 2026-10-22: `cfo_session=x` opened the dashboard), so recompute the signature
// and compare in constant time. Changing APP_PASSCODE logs every device out.
export function validSession(token: string, passcode: string): boolean {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false
  const given = Buffer.from(token.slice(dot + 1), 'hex')
  const want = crypto.createHmac('sha256', passcode).update(token.slice(0, dot)).digest()
  return given.length === want.length && crypto.timingSafeEqual(given, want)
}

// No APP_PASSCODE set = no lock installed, so everyone is "unlocked" (the gate
// lets everything through in that case too).
export function unlocked(token: string | undefined): boolean {
  const passcode = (process.env.APP_PASSCODE ?? '').trim()
  if (!passcode) return true
  return !!token && validSession(token, passcode)
}
