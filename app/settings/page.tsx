import { demoEnabled } from '@/lib/settings'
import { PROJECTS } from '@/lib/ad-clients'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import DemoToggle from '@/app/_components/DemoToggle'

export const dynamic = 'force-dynamic'

// 👉 Settings. Right now it holds one switch, and one switch earns a page:
// flipping demo data on the morning of a presentation shouldn't mean editing
// code, redeploying, or remembering a script name two weeks later.

async function sampleCounts() {
  if (!supabaseConfigured) return { records: 0, funnel: 0, adDays: 0, competitors: 0 }
  const demoIds = PROJECTS.filter((p) => p.demo).map((p) => p.id)
  const [records, funnel, adDays, competitors] = await Promise.all([
    supabase.from('records').select('id', { count: 'exact', head: true }).filter('meta->>sample', 'eq', 'true'),
    supabase.from('project_funnel').select('id', { count: 'exact', head: true }).eq('source', 'sample'),
    supabase.from('ad_daily').select('id', { count: 'exact', head: true }).in('project', demoIds),
    supabase.from('competitor_ads').select('id', { count: 'exact', head: true }).in('client', demoIds),
  ])
  return {
    records: records.count ?? 0,
    funnel: funnel.count ?? 0,
    adDays: adDays.count ?? 0,
    competitors: competitors.count ?? 0,
  }
}

export default async function Settings() {
  const [on, counts] = await Promise.all([demoEnabled(), sampleCounts()])
  const demoProjects = PROJECTS.filter((p) => p.demo)
  // What the switch actually saves: one Adyntel credit per keyword per country,
  // per demo client, every morning.
  const dailyCredits = demoProjects.reduce(
    (n, p) => n + Math.min(p.keywordsPerRun || p.keywords.length, p.keywords.length) * p.countries.length,
    0,
  )

  return (
    <>
      <h1 className="ph">Settings</h1>
      <p className="cap">Switches that change what the dashboard shows and what the robots spend.</p>

      <div className="band">
        <div className="band-head">
          <h2>Sample data</h2>
          <span>{on ? `costing ~${dailyCredits} Adyntel credits/day` : 'costing nothing'}</span>
        </div>

        <DemoToggle initial={on} />

        <p className="set-note">
          <b>On</b> — the seeded rows appear everywhere and the sample clients (
          {demoProjects.map((p) => p.client ?? p.name).join(', ')}) get a morning brief like any real
          client, which searches Adyntel and spends about <b>{dailyCredits} credits a day</b>.
        </p>
        <p className="set-note">
          <b>Off</b> — those clients disappear from the dashboard, the sidebar, the Telegram bot and
          the morning cron, and the seeded invoices, expenses, leads and tasks are hidden from every
          tab. <b>Nothing is deleted</b>: flip it back on and it all returns exactly as it was.
        </p>

        <table className="tbl" style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>What&apos;s stored</th>
              <th>Rows</th>
              <th>Hidden when off</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="What's stored">Invoices, expenses, customers, leads, tasks</td>
              <td data-label="Rows">{counts.records}</td>
              <td data-label="Hidden when off">yes</td>
            </tr>
            <tr>
              <td data-label="What's stored">Funnel numbers (attendance, appointments)</td>
              <td data-label="Rows">{counts.funnel}</td>
              <td data-label="Hidden when off">yes</td>
            </tr>
            <tr>
              <td data-label="What's stored">Sample ad-days</td>
              <td data-label="Rows">{counts.adDays}</td>
              <td data-label="Hidden when off">yes — with their projects</td>
            </tr>
            <tr>
              <td data-label="What's stored">Competitor ads for sample clients</td>
              <td data-label="Rows">{counts.competitors}</td>
              <td data-label="Hidden when off">yes — no new searches</td>
            </tr>
          </tbody>
        </table>

        <p className="set-note" style={{ marginTop: 14 }}>
          To delete it permanently rather than hide it:{' '}
          <code>node --env-file-if-exists=.env scripts/sample-data.mjs --purge</code>
        </p>
      </div>
    </>
  )
}
