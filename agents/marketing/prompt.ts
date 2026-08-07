// 👉 THIS FILE IS YOURS TO EDIT — the 4th knob: SUGGEST (the words).
//
// This is the ONLY place you write what the Head of Marketing says. Everything
// here is a RECOMMENDATION you read and act on yourself — the head has no hands
// in your ad account. It cannot pause, boost, or edit anything.
//
// Two voices:
//   • headline() — the one line on the Approvals card / Telegram button.
//   • suggest()  — the full recommendation you read before deciding.
//
// ⚠️ Runtime-import-free, same rule as definition.ts — the imports below are
// TYPE-only so scripts/marketing-dry-run.ts can run this under plain node.

import type { AdAgg, CplBaseline, Finding } from './definition'

const rm = (n: number) => 'RM ' + Number(n || 0).toLocaleString('en-MY', { maximumFractionDigits: 2 })
const int = (n: number) => Number(n || 0).toLocaleString('en-MY')
const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(2)}%`)

// An ad that is already paused should never be told to pause. Meta's statuses are
// noisy (ACTIVE, PAUSED, CAMPAIGN_PAUSED, ADSET_PAUSED, ARCHIVED…), so treat
// anything that isn't plainly ACTIVE as already off.
const isRunning = (a: AdAgg) => (a.status || '').toUpperCase() === 'ACTIVE'

const statusLine = (a: AdAgg) =>
  a.status ? `Status: ${a.status}${isRunning(a) ? ' (still spending)' : ' (already off)'}` : ''

// What to actually do about it — the only line that asks you to move.
function yourCall(a: AdAgg, stop: boolean): string {
  if (stop) {
    return isRunning(a)
      ? `Your call: pause it in Meta Ads Manager. I don't touch your ad account.`
      : `Your call: it's already off — the decision is not to relaunch this creative. I don't touch your ad account.`
  }
  return isRunning(a)
    ? `Your call: raise the budget in Meta Ads Manager. I don't touch your ad account.`
    : `Your call: this one is paused — worth switching back on and funding. I don't touch your ad account.`
}

// The short line — Approvals card, Telegram message, morning brief.
export function headline(f: Finding, base: CplBaseline): string {
  const a = f.ad
  if (f.issue === 'dud') {
    return `📊 <b>${a.name}</b> — ${rm(a.spend)} spent, <b>zero leads</b>. ${isRunning(a) ? 'Turn it off?' : 'Keep it off?'}`
  }
  if (f.issue === 'expensive') {
    return (
      `📊 <b>${a.name}</b> — ${rm(a.cpl as number)} per lead vs your ${rm(base.cpl)} average. ` +
      `<b>${rm(f.wastedSpend)}</b> more than those ${int(a.leads)} leads should have cost. Review it?`
    )
  }
  return (
    `📈 <b>${a.name}</b> — your biggest cheap winner: ${int(a.leads)} leads at ` +
    `${rm(a.cpl as number)} vs your ${rm(base.cpl)} average, saving <b>${rm(-f.wastedSpend)}</b>. Put more behind it?`
  )
}

// 👉 CHANGE THIS — the full recommendation. Plain text; you read it, you decide.
export function suggest(f: Finding, base: CplBaseline): string {
  const a = f.ad
  const where = [a.project, a.campaign].filter(Boolean).join(' · ')
  const facts = [
    where,
    statusLine(a),
    `${rm(a.spend)} spent · ${int(a.leads)} leads · ${int(a.impressions)} impressions · ${int(a.linkClicks)} link clicks · ${pct(a.ctr)} CTR`,
    `This ad: ${a.cpl === null ? 'no leads at all' : `${rm(a.cpl)} per lead`}`,
    `Your average: ${rm(base.cpl)} per lead (${rm(base.spend)} → ${int(base.leads)} leads across ${base.ads} ads)`,
  ]
    .filter(Boolean)
    .join('\n')

  if (f.issue === 'dud') {
    return (
      `KILL — "${a.name}"\n\n${facts}\n\n` +
      `It spent ${rm(a.spend)} and produced nothing at all. There's no rate to improve here and ` +
      `nothing to optimise — that money bought no pipeline.\n\n` +
      `${yourCall(a, true)}`
    )
  }

  if (f.issue === 'expensive') {
    const shouldHaveCost = a.leads * base.cpl
    return (
      `REVIEW — "${a.name}"\n\n${facts}\n\n` +
      `Those ${int(a.leads)} leads should have cost about ${rm(shouldHaveCost)} at your normal rate. ` +
      `They cost ${rm(a.spend)}. The gap is ${rm(f.wastedSpend)}, and that's the number worth acting on — ` +
      `not the ratio.\n\n` +
      `Note this is a MONEY size, not a badness score: an ad only slightly above your average can leak ` +
      `far more than a terrible one that barely spent, simply because it spent more. This one made the ` +
      `list because of the size of the gap.\n\n` +
      `Check the offer-to-page match and the audience before you touch the creative.\n\n` +
      `${yourCall(a, true)}`
    )
  }

  const saved = -f.wastedSpend
  return (
    `SCALE — "${a.name}"\n\n${facts}\n\n` +
    `This is the most productive ad you have that also beats your own average. ` +
    `${int(a.leads)} leads is the biggest haul among ads cheaper than ${rm(base.cpl)}, and at ` +
    `${rm(a.cpl as number)} each it brought those leads in for ${rm(saved)} less than your baseline ` +
    `would have.\n\n` +
    `Worth more budget, and worth copying: whatever this one gets right is the pattern the ads on ` +
    `the list above are missing.\n\n` +
    `${yourCall(a, false)}`
  )
}
