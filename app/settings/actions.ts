'use server'

import { revalidatePath } from 'next/cache'
import { setDemoEnabled } from '@/lib/settings'

// The demo switch, flipped from the UI. Thin 'use server' wrapper so the client
// toggle never imports lib/supabase.ts (which is behind `server-only`).
export async function toggleDemo(on: boolean): Promise<{ ok: boolean; on: boolean; message: string }> {
  try {
    await setDemoEnabled(on)
    // Everything reads the switch, so everything has to re-render.
    revalidatePath('/', 'layout')
    return {
      ok: true,
      on,
      message: on
        ? 'Sample data is ON — demo clients are back on the dashboard and in tomorrow’s brief.'
        : 'Sample data is OFF — demo clients are hidden and will not spend Adyntel credits.',
    }
  } catch (e) {
    return { ok: false, on: !on, message: (e as Error).message }
  }
}
