import './globals.css'
import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import { Sora, Hanken_Grotesk } from 'next/font/google'
import Nav from './_components/Nav'
import BottomNav from './_components/BottomNav'
import ConnStatus from './_components/ConnStatus'
import Brand from './_components/Brand'
import ThemeToggle from './_components/ThemeToggle'
import { getPendingCount, getRecords } from '@/lib/records'
import { workProjectsFrom } from '@/lib/work-projects'
import { activeProjects } from '@/lib/settings'
import { THEME_COLOR, THEME_COOKIE, themeFrom } from '@/lib/theme'
import { SESSION_COOKIE, unlocked } from '@/lib/session'

// SpeakFunnels type (Brand Guidelines v1.0 §04): Sora for headlines and the
// wordmark, Hanken Grotesk for everything else. next/font self-hosts both under
// /_next/, which the passcode gate already lets through.
const sora = Sora({ subsets: ['latin'], variable: '--font-display', display: 'swap' })
const hanken = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-body', display: 'swap' })

export const metadata: Metadata = {
  title: 'SpeakFunnels Command Centre',
  description: 'Every project, funnel and robot in one place.',
  manifest: '/manifest.webmanifest',
  // /icons/ is on the passcode gate's allowlist (proxy.ts); app/apple-icon.png
  // would be served from /apple-icon.png, which the gate would redirect.
  icons: { apple: '/icons/apple-icon-180.png' },
  appleWebApp: { capable: true, title: 'Command Centre', statusBarStyle: 'default' },
}

// theme-color drives the phone status-bar tint when installed to the home
// screen; it follows the theme the cookie asks for.
export async function generateViewport(): Promise<Viewport> {
  const theme = themeFrom((await cookies()).get(THEME_COOKIE)?.value)
  return { themeColor: THEME_COLOR[theme], width: 'device-width', initialScale: 1 }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies()
  const theme = themeFrom(jar.get(THEME_COOKIE)?.value)
  const htmlProps = { lang: 'en', 'data-theme': theme, className: `${sora.variable} ${hanken.variable}` }

  // A visitor who hasn't unlocked the app only ever reaches /login (the gate
  // never sees that path), so they get the page alone: no sidebar, no project or
  // client names, no database reads.
  if (!unlocked(jar.get(SESSION_COOKIE)?.value)) {
    return (
      <html {...htmlProps}>
        <body>
          <main className="main locked">{children}</main>
        </body>
      </html>
    )
  }

  // The nav is a client component and the project list depends on the database
  // (the demo switch, and the work projects live in `records`), so the server
  // resolves both here and hands them down. Ad clients first, then work.
  const [pending, projects, rows] = await Promise.all([getPendingCount(), activeProjects(), getRecords()])
  const navProjects = [
    ...projects
      .slice()
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
      .map(p => ({ id: p.id, label: (typeof p.rank === 'number' ? `${p.rank}. ` : '') + (p.client ?? p.name) })),
    ...workProjectsFrom(rows)
      .filter(w => !['done', 'completed', 'closed'].includes(w.status.toLowerCase()))
      .map(w => ({ id: w.slug, label: w.client ?? w.name })),
  ]
  return (
    <html {...htmlProps}>
      <body>
        <div className="app">
          {/* Desktop sidebar — hidden on phones (the top bar + BottomNav take over ≤768px). */}
          <aside className="side">
            <Brand />
            <Nav pendingCount={pending} projects={navProjects} />
            <div className="side-foot">
              <ThemeToggle initial={theme} />
              <p className="tagline">Where story becomes impact</p>
            </div>
          </aside>
          <header className="mtop">
            <Brand />
            <ThemeToggle initial={theme} compact />
          </header>
          <main className="main"><ConnStatus />{children}</main>
        </div>
        {/* Phone bottom bar — hidden on desktop. */}
        <BottomNav projects={navProjects} />
      </body>
    </html>
  )
}
