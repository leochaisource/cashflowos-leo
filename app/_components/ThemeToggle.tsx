'use client'
import { useEffect, useState } from 'react'
import Icon from './Icon'
import { THEME_COLOR, THEME_COOKIE, type Theme } from '@/lib/theme'

// Dark is the Command Centre's default; light is one tap away. The choice is a
// cookie that the root layout reads, so the server paints the right theme first
// time — no flash of the wrong one on load. The sidebar and the phone top bar
// each hold a toggle; an `sf-theme` window event keeps both labels in step.
export default function ThemeToggle({ initial, compact = false }: { initial: Theme; compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>(initial)
  const next: Theme = theme === 'dark' ? 'light' : 'dark'

  useEffect(() => {
    const sync = (e: Event) => setTheme((e as CustomEvent<Theme>).detail)
    window.addEventListener('sf-theme', sync)
    return () => window.removeEventListener('sf-theme', sync)
  }, [])

  function flip() {
    document.documentElement.dataset.theme = next
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next])
    window.dispatchEvent(new CustomEvent<Theme>('sf-theme', { detail: next }))
  }

  return (
    <button
      type="button"
      className={compact ? 'theme-toggle compact' : 'theme-toggle'}
      onClick={flip}
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
    >
      <Icon name={next === 'light' ? 'sun' : 'moon'} />
      {compact ? null : <span>{next === 'light' ? 'Light theme' : 'Dark theme'}</span>}
    </button>
  )
}
