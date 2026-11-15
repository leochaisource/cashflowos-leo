import 'server-only'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, unlocked } from './session'

// SERVER ACTIONS CHECK THE SESSION THEMSELVES (2026-11-15). A server action is a
// POST to its page that anyone can send, so the login gate in proxy.ts is the only
// thing between the internet and these writes. A proxy bypass in the framework
// (Next.js GHSA-6gpp-xcg3-4w24, fixed in 16.4.6) would open them all. Each action
// in app/**/actions.ts asks this first: the same cookie check as the gate.
export async function signedIn(): Promise<boolean> {
  const jar = await cookies()
  return unlocked(jar.get(SESSION_COOKIE)?.value)
}

export const SIGNED_OUT = 'Your session has ended. Reload the page and sign in again.'
