'use client'
import { useState, useTransition } from 'react'
import { refreshProject } from '@/app/projects/[id]/actions'

// Pulls Meta on demand. Costs nothing but a Graph call — no Adyntel credits, no
// model call — so it's safe to press as often as you like. The 8am cron does the
// same thing while you're asleep; this is for when you've just changed something
// and don't want to wait until tomorrow to see it.

export default function RefreshButton({ project, days = 14 }: { project: string; days?: number }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="refresh">
      <button
        type="button"
        className="btn ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await refreshProject(project, days)
            setMsg({ ok: r.ok, text: r.message })
          })
        }
      >
        {pending ? 'Pulling from Meta…' : '↻ Refresh'}
      </button>
      {msg ? <span className={msg.ok ? 'entry-ok' : 'entry-err'}>{msg.text}</span> : null}
    </div>
  )
}
