'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toggleDemo } from '@/app/settings/actions'

// The switch itself. Optimistic on click, corrected if the write fails, and it
// refreshes the router afterwards so the sidebar, the home grid and the money
// row all change in the same beat.
export default function DemoToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const router = useRouter()

  const flip = () =>
    start(async () => {
      const next = !on
      setOn(next)
      const r = await toggleDemo(next)
      setOn(r.on)
      setMsg(r.message)
      router.refresh()
    })

  return (
    <div className="toggle-row">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Sample data"
        className={`switch${on ? ' on' : ''}`}
        onClick={flip}
        disabled={pending}
      >
        <span className="knob" />
      </button>
      <div>
        <p className="toggle-state">
          {pending ? 'Saving…' : on ? 'ON — sample data is showing' : 'OFF — real clients only'}
        </p>
        {msg ? <p className="toggle-msg">{msg}</p> : null}
      </div>
    </div>
  )
}
