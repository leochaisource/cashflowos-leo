import crypto from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

// 🔒 Don't edit — this keeps your robot safe.
// The passcode gate. In Next 16 this file is called `proxy.ts` (the old name
// `middleware.ts` is deprecated and would print scary warnings for beginners).
//
// It's "a lock on the door, not bank-grade auth": if APP_PASSCODE is set and the
// visitor has no session cookie, we bounce them to /login. If APP_PASSCODE is NOT
// set, we DON'T gate anything — the app shows a calm setup banner instead, so a
// half-configured clone never locks you out of your own HQ.
export function proxy(req: NextRequest) {
  const passcode = (process.env.APP_PASSCODE ?? '').trim()
  if (!passcode) return NextResponse.next()          // no lock installed → open door

  const session = req.cookies.get('cfo_session')?.value
  if (session && validSession(session, passcode)) return NextResponse.next() // a cookie /api/login signed → allow

  const url = req.nextUrl.clone()
  url.pathname = '/login'
  return NextResponse.redirect(url)
}

// /api/login mints the cookie as `nonce.HMAC(nonce)`, signed with APP_PASSCODE.
// Checking only that a cookie EXISTED let any made-up value in (found live on
// 2026-10-22: `cfo_session=x` opened the dashboard), so recompute the signature
// and compare in constant time. Changing APP_PASSCODE logs every device out.
function validSession(token: string, passcode: string): boolean {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false
  const given = Buffer.from(token.slice(dot + 1), 'hex')
  const want = crypto.createHmac('sha256', passcode).update(token.slice(0, dot)).digest()
  return given.length === want.length && crypto.timingSafeEqual(given, want)
}

// The matcher protects every page EXCEPT the ones below, which must stay reachable
// without the cookie:
//   • /login, /api/login      — you can't log in through a locked login page
//   • /api/telegram           — Telegram's webhook (has its own secret-header guard)
//   • /api/cron-daily         — the daily cron (has its own fail-closed Bearer guard)
//   • /api/cron-ads           — the 8am ads brief (same fail-closed Bearer guard)
//   • /api/sync-ads           — the Meta→dashboard sync (same fail-closed Bearer guard)
//   • /api/eventops           — Kingsley's EventOps seat feed (fail-closed EVENTOPS_SECRET Bearer)
//   • /api/hotleads-sync      — the sheet's 9am/12pm/6pm trigger (fail-closed SHEETS_HOTLEADS_SECRET Bearer)
//   • /api/closer-coach       — the 9am closing coach, started by hotleads-sync (same Bearer)
//   • /api/hotlist-tick       — Ariella's hourly list check, from the sheet's trigger (same Bearer)
//   • /api/intent-batch       — the overnight half-price lead judging, same hourly trigger (same Bearer)
//   • /api/lead-journey       — the funnel's Call Log feed + morning journey rebuild, same trigger (same Bearer)
//   • /api/calendar           — the ICS feed Google Calendar subscribes to; calendar
//     fetchers can't log in or send headers, so it carries its own URL token
//   • /manifest.webmanifest   — the REAL PWA manifest (app/manifest.ts serves HERE);
//     /manifest.json          — belt-and-braces extra so install never silently breaks
//   • /icons/*, /favicon.ico, /icon.png, /_next/* — static assets the install/render
//     needs. /icon.png is where Next's App Router serves app/icon.png (the browser
//     tab favicon) — without it the gate 307s the tab icon to /login and the login
//     screen renders with a blank icon.
// A single missed exclusion here = a locked webhook on class day, so this list is tested.
export const config = {
  matcher: [
    '/((?!login|api/login|api/telegram|api/cron-daily|api/cron-ads|api/sync-ads|api/eventops|api/hotleads-sync|api/hotlist-tick|api/intent-batch|api/lead-journey|api/closer-coach|api/calendar|manifest\\.webmanifest|manifest\\.json|icons|icon\\.png|_next|favicon\\.ico).*)',
  ],
}
