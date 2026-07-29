'use client'
import { useState, useTransition } from 'react'
import { saveFunnelNumbers, type FunnelInput } from '@/app/projects/[id]/actions'

// The stopgap for everything Meta can't tell us: who opted in on the GHL page,
// who actually attended, who booked, who bought, what got banked.
//
// It exists so ROAS and show-up rate work TODAY, before GHL and the master
// leads sheet are wired. When they are, this form stays as the manual override
// — the `source` column already records which is which.
//
// Deliberate: an empty box saves NULL (tile stays blank), a typed 0 saves 0
// (tile shows 0). Never pre-fill these with zeros.

const FIELDS: { key: keyof FunnelInput; label: string; hint: string }[] = [
  { key: 'leads', label: 'Opt-ins', hint: 'GHL landing page' },
  { key: 'attended', label: 'Attended', hint: 'master sheet' },
  { key: 'appointments', label: 'Appointments', hint: 'booked' },
  { key: 'signups', label: 'Sign-ups', hint: 'paid' },
  { key: 'cash_collected', label: 'Cash collected', hint: 'banked' },
]

export default function FunnelEntryForm({ project, today }: { project: string; today: string }) {
  const [date, setDate] = useState(today)
  const [values, setValues] = useState<FunnelInput>({})
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()

  const set = (k: keyof FunnelInput, v: string) => setValues((s) => ({ ...s, [k]: v }))

  const submit = () =>
    start(async () => {
      const r = await saveFunnelNumbers(project, date, values)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) setValues({})
    })

  return (
    <div className="entry">
      <div className="entry-row">
        <label className="entry-f">
          <span className="l">Date</span>
          <input
            type="date"
            className="entry-in"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {FIELDS.map((f) => (
          <label className="entry-f" key={f.key}>
            <span className="l">
              {f.label} <em>{f.hint}</em>
            </span>
            <input
              type="text"
              inputMode="decimal"
              className="entry-in"
              placeholder="—"
              value={values[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="entry-actions">
        <button type="button" className="btn" onClick={submit} disabled={pending}>
          {pending ? 'Saving…' : 'Save numbers'}
        </button>
        <span className="entry-note">
          Leave a box empty and it stays unrecorded. Type 0 and it means zero.
        </span>
      </div>
      {msg ? <p className={msg.ok ? 'entry-ok' : 'entry-err'}>{msg.text}</p> : null}
    </div>
  )
}
