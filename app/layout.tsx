import './globals.css'
import type { Metadata, Viewport } from 'next'
import Nav from './_components/Nav'
import BottomNav from './_components/BottomNav'
import ConnStatus from './_components/ConnStatus'
import { getPendingCount } from '@/lib/records'
import { activeProjects } from '@/lib/settings'

export const metadata: Metadata = {
  title: 'Firstin5 Dashboard',
  description: 'Your Money Robot — one AI HQ for the whole business.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Firstin5', statusBarStyle: 'default' },
}

// theme-color drives the phone status-bar tint when installed to the home screen.
export const viewport: Viewport = {
  themeColor: '#FAF7F2',
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The nav is a client component and the project list depends on a database
  // switch, so the server resolves it once here and hands it down.
  const [pending, projects] = await Promise.all([getPendingCount(), activeProjects()])
  const navProjects = projects.map(p => ({ id: p.id, label: p.client ?? p.name }))
  return (
    <html lang="en">
      <body>
        <div className="app">
          {/* Desktop sidebar — hidden on phones (BottomNav takes over ≤768px). */}
          <aside className="side">
            <div className="brand">
              {/* Lives under /icons/ because proxy.ts only lets that folder past the passcode gate. */}
              <img className="logo" src="/icons/firstin5-logo.svg" alt="" width={26} height={26} />
              Firstin5 Dashboard
            </div>
            <Nav pendingCount={pending} projects={navProjects} />
            <p className="hint">One <code>records</code> table behind every tab. Your robots live in <code>agents/</code>.</p>
          </aside>
          <main className="main"><ConnStatus />{children}</main>
        </div>
        {/* Phone bottom bar — hidden on desktop. */}
        <BottomNav projects={navProjects} />
      </body>
    </html>
  )
}
