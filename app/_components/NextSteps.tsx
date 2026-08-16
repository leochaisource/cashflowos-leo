'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addStep, setStepDone } from '@/app/projects/[id]/actions'
import type { Step } from '@/lib/work-projects'

// The mini project-management band: the project's next steps, tick-offable,
// with an add form. Same band on ad-client pages and work-project pages —
// meta.project doesn't care which kind of id it holds.
//
// Ticking is optimistic: the row greys instantly, the server catches up, and
// router.refresh() re-renders the page (and the sidebar counts) from truth.

export default function NextSteps({
  projectId,
  open,
  done,
  today,
}: {
  projectId: string
  open: Step[]
  done: Step[]
  today: string
}) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [pending, start] = useTransition()
  const router = useRouter()

  const tick = (id: number, to: boolean) =>
    start(async () => {
      setBusy(id)
      const r = await setStepDone(id, to)
      setBusy(null)
      if (!r.ok) setMsg({ ok: false, text: r.message })
      router.refresh()
    })

  const add = () =>
    start(async () => {
      const r = await addStep(projectId, title, due)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) {
        setTitle('')
        setDue('')
      }
      router.refresh()
    })

  const dueLabel = (s: Step) => {
    if (!s.due) return 'no deadline'
    const days = Math.round((Date.parse(s.due) - Date.parse(today)) / 86_400_000)
    if (s.overdue) return `${s.due} · ${-days}d overdue`
    if (days === 0) return 'due today'
    if (days === 1) return 'due tomorrow'
    return `${s.due} · in ${days}d`
  }

  return (
    <div className="band">
      <div className="band-head">
        <h2>Next steps</h2>
        <span>
          {open.length ? `${open.length} open` : 'nothing open'}
          {open.some((s) => s.overdue) ? ` · ${open.filter((s) => s.overdue).length} overdue` : ''}
        </span>
      </div>

      {open.length === 0 && done.length === 0 ? (
        <div className="empty">No steps yet — add the first one below.</div>
      ) : (
        <ul className="steps">
          {open.map((s) => (
            <li key={s.id} className={`step${s.overdue ? ' late' : ''}`}>
              <button
                type="button"
                className="stepchk"
                aria-label={`Mark “${s.title}” done`}
                disabled={pending && busy === s.id}
                onClick={() => tick(s.id, true)}
              />
              <span className="t">{s.title}</span>
              <span className="d">{dueLabel(s)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="entry-actions" style={{ marginTop: open.length ? 12 : 0 }}>
        <input
          type="text"
          className="entry-in"
          style={{ flex: 1, minWidth: 180 }}
          placeholder="Add a next step…"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && title.trim()) add()
          }}
        />
        <input type="date" className="entry-in" style={{ width: 160 }} value={due} onChange={(e) => setDue(e.target.value)} />
        <button type="button" className="btn" onClick={add} disabled={pending || !title.trim()}>
          {pending ? 'Saving…' : 'Add step'}
        </button>
      </div>
      {msg ? <p className={msg.ok ? 'entry-ok' : 'entry-err'}>{msg.text}</p> : null}

      {done.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="chip" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Hide' : 'Show'} done <span className="n">{done.length}</span>
          </button>
          {showDone && (
            <ul className="steps" style={{ marginTop: 10 }}>
              {done.slice(0, 10).map((s) => (
                <li key={s.id} className="step done">
                  <button
                    type="button"
                    className="stepchk on"
                    aria-label={`Reopen “${s.title}”`}
                    onClick={() => tick(s.id, false)}
                  >
                    ✓
                  </button>
                  <span className="t">{s.title}</span>
                  <span className="d">{s.due ?? ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
