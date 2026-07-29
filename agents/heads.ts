// The C-Suite — the org chart from docs/ai-csuite-blueprint.md, as a structure.
//
// A HEAD is a department lens, not a robot. It owns some agents, watches some
// record categories, and answers ONE question for the Dashboard: "what would you
// tell the CEO right now?" Heads never act — the agents underneath them do, and
// even those only ever propose (see lib/actions.ts).
//
// Every head reads the SAME `records` spine. They don't need new data — they need
// a lens on the data you're already capturing.
//
// 👉 To turn a head ON: give its agent a `definition.ts` + `prompt.ts`, add it to
//    SCHEDULED in agents/registry.ts, and change its brief() below to report real
//    numbers. `marketing` is the worked example — copy its shape.

import type { Rec } from '@/lib/records'
import { adStats, baseline, findings } from './marketing/definition'

export type HeadKey = 'sales' | 'marketing' | 'finance' | 'ops'

// 'live'    — turned on, sweeping, and has fuel to work with.
// 'off'     — the data is there, but nobody has wired the agent up yet.
// 'no-fuel' — wired or not, there are no rows in its categories to read.
export type HeadState = 'live' | 'off' | 'no-fuel'

export type HeadBrief = {
  state: HeadState
  headline: string // the one line the Dashboard card shows
  count: number // how many things it wants to say to you right now
}

export type Head = {
  key: HeadKey
  label: string
  emoji: string
  watches: string[] // which `records` categories it reads
  agentKeys: string[] // which registry agents report to it
  dial: string // where its 🟢/🟡 line sits, in words
  brief: (rows: Rec[], today: string) => HeadBrief
}

const inCat = (rows: Rec[], ...cats: string[]) => rows.filter((r) => cats.includes(r.category || ''))
const isStatus = (r: Rec, ...s: string[]) => s.includes((r.status || '').toLowerCase())

export const HEADS: Head[] = [
  // ---- 🎯 SALES — has fuel, agent not wired yet ----
  {
    key: 'sales',
    label: 'Head of Sales',
    emoji: '🎯',
    watches: ['lead', 'customer'],
    agentKeys: ['cold-lead', 'viewing-followup'],
    dial: '🟡 Drafts every follow-up — a message to a real person is never autopilot.',
    brief: (rows) => {
      const leads = inCat(rows, 'lead')
      if (leads.length === 0)
        return { state: 'no-fuel', headline: 'No lead rows yet — nothing to work.', count: 0 }
      const untouched = leads.filter((r) => isStatus(r, 'new')).length
      return {
        state: 'off',
        headline: `${leads.length} leads · ${untouched} never contacted — head not turned on yet.`,
        count: 0,
      }
    },
  },

  // ---- 📣 MARKETING — LIVE (the head you installed) ----
  {
    key: 'marketing',
    label: 'Head of Marketing',
    emoji: '📣',
    watches: ['content'],
    agentKeys: ['marketing-triage', 'content-approval'],
    dial: '🟡 Every kill/scale call asks first — it has no hands in your ad account.',
    brief: (rows) => {
      const stats = adStats(rows)
      const base = baseline(stats)
      if (!base) {
        const anyContent = inCat(rows, 'content').length
        return {
          state: 'no-fuel',
          headline: anyContent
            ? `${anyContent} content rows, but none with enough ad clicks to judge yet.`
            : 'No content rows yet — nothing to grade.',
          count: 0,
        }
      }
      const list = findings(stats, base)
      const problems = list.filter((f) => f.issue !== 'scale').length
      const scaling = list.filter((f) => f.issue === 'scale').length
      if (list.length === 0)
        return {
          state: 'live',
          headline: `${base.ads} ads graded — none below your ${(base.cvr * 100).toFixed(1)}% average. All clear.`,
          count: 0,
        }
      const bits = [
        problems ? `${problems} ad${problems > 1 ? 's' : ''} converting below your average` : '',
        scaling ? `${scaling} to scale` : '',
      ].filter(Boolean)
      return {
        state: 'live',
        headline: `${base.ads} ads graded · ${bits.join(' · ')}.`,
        count: list.length,
      }
    },
  },

  // ---- 💰 FINANCE — wired, but no fuel ----
  {
    key: 'finance',
    label: 'Head of Finance',
    emoji: '💰',
    watches: ['cash_in', 'cash_out'],
    agentKeys: ['overdue-invoice', 'expense', 'vault'],
    dial: '🟢 Files spend at or under your threshold · 🟡 asks above it. Never moves money.',
    brief: (rows) => {
      const owed = inCat(rows, 'cash_in').filter((r) => !isStatus(r, 'paid', 'done', 'closed', 'reversed'))
      if (inCat(rows, 'cash_in').length === 0)
        return {
          state: 'no-fuel',
          headline: 'No cash_in rows yet — the invoice chaser has nothing to chase.',
          count: 0,
        }
      return {
        state: 'live',
        headline: `${owed.length} unpaid invoice${owed.length === 1 ? '' : 's'} on the books.`,
        count: owed.length,
      }
    },
  },

  // ---- ⚙️ OPS — no fuel ----
  {
    key: 'ops',
    label: 'Head of Ops',
    emoji: '⚙️',
    watches: ['task', 'doc'],
    agentKeys: ['leave-claim', 'renewal-nudge'],
    dial: '🟢 Files and labels docs · 🟡 asks before any status change with money impact.',
    brief: (rows) => {
      const work = inCat(rows, 'task', 'doc')
      if (work.length === 0)
        return { state: 'no-fuel', headline: 'No task or doc rows yet — nothing to watch.', count: 0 }
      const open = work.filter((r) => !isStatus(r, 'done', 'closed', 'filed')).length
      return { state: 'live', headline: `${open} open of ${work.length} items.`, count: open }
    },
  },
]

// Agents that report to no head — read-only, cross-department, answers to you directly.
export const DIRECT_REPORT_KEYS = ['jarvis']

// Which head owns a given agent key (used to group the AI Employees tab).
export function headForAgent(agentKey: string): Head | undefined {
  return HEADS.find((h) => h.agentKeys.includes(agentKey))
}
