// 👉 THIS FILE IS YOURS TO EDIT — the 4th knob: SUGGEST (the words).
//
// This is the ONLY place you write what the Head of Marketing says. Everything
// here is a RECOMMENDATION you read and act on yourself — the head has no hands
// in your ad account. It cannot pause, boost, or edit anything.
//
// Two voices:
//   • headline() — the one line that shows on the Approvals card / Telegram button.
//   • suggest()  — the full recommendation you read before deciding.
//
// ⚠️ Runtime-import-free, same rule as definition.ts — the `Finding`/`Baseline`
// imports are TYPE-only so scripts/marketing-dry-run.ts can run this under plain
// node. Keep any value import out of this file.

import type { Baseline, Finding } from './definition'

const pct = (n: number) => `${(n * 100).toFixed(2)}%`
const int = (n: number) => Number(n || 0).toLocaleString('en-MY')

// The short line — Approvals card, Telegram message, morning brief.
export function headline(f: Finding, base: Baseline): string {
  const s = f.stat
  if (f.issue === 'dud') {
    return `📊 <b>${s.title}</b> — ${int(s.clicks)} clicks, <b>zero leads</b>. Turn it off?`
  }
  if (f.issue === 'mismatch') {
    return (
      `📊 <b>${s.title}</b> — ${pct(s.ctr)} CTR (above your ${pct(base.ctr)} average) ` +
      `but only ${pct(s.cvr)} of clicks become leads. ~${int(f.wastedClicks)} clicks wasted. Review it?`
    )
  }
  return (
    `📈 <b>${s.title}</b> — your biggest above-average earner: ` +
    `${int(s.leads)} leads from ${int(s.clicks)} clicks (${pct(s.cvr)} vs your ${pct(base.cvr)}). Put more behind it?`
  )
}

// 👉 CHANGE THIS — the full recommendation. Plain text; you read it, you decide.
export function suggest(f: Finding, base: Baseline): string {
  const s = f.stat
  const when = s.date ? ` (ran ${s.date})` : ''
  const facts =
    `${int(s.reach)} reach · ${int(s.views)} views · ${int(s.clicks)} clicks · ${int(s.leads)} leads\n` +
    `This ad: ${pct(s.ctr)} CTR · ${pct(s.cvr)} click→lead\n` +
    `Your average: ${pct(base.ctr)} CTR · ${pct(base.cvr)} click→lead (across ${base.ads} ads)`

  if (f.issue === 'dud') {
    return (
      `KILL — "${s.title}"${when}\n\n${facts}\n\n` +
      `It spent ${int(s.clicks)} clicks and produced nothing at all. Nothing to optimise here — ` +
      `switch it off and move the budget to something that converts.\n\n` +
      `Your call: pause it in Meta Ads Manager. I don't touch your ad account.`
    )
  }

  if (f.issue === 'mismatch') {
    return (
      `REVIEW — "${s.title}"${when}\n\n${facts}\n\n` +
      `This is attention without intent. The creative is doing its job — ${pct(s.ctr)} CTR beats ` +
      `your ${pct(base.ctr)} average, so people want to click. But only ${pct(s.cvr)} of them ` +
      `become leads against your ${pct(base.cvr)} average, so what they land on isn't what they ` +
      `were promised.\n\n` +
      `At your normal rate those ${int(s.clicks)} clicks would have been about ` +
      `${int(Math.round(s.clicks * base.cvr))} leads instead of ${int(s.leads)} — roughly ` +
      `${int(f.wastedClicks)} clicks' worth of demand lost after the click.\n\n` +
      `Look at the landing page and the offer match BEFORE you touch the creative — the creative ` +
      `is the part that's already working.\n\n` +
      `Your call: fix the page, or pause the ad. I don't touch your ad account.`
    )
  }

  return (
    `SCALE — "${s.title}"${when}\n\n${facts}\n\n` +
    `This is the most productive ad you have that also beats your own average: ` +
    `${int(s.leads)} leads is the biggest haul among ads converting above ${pct(base.cvr)}, ` +
    `and it did it across ${int(s.clicks)} clicks — enough traffic that it isn't a fluke.\n\n` +
    `Worth more budget, and worth copying: whatever the promise-to-page match is on this one, ` +
    `it's the pattern your weaker ads are missing.\n\n` +
    `Your call: raise the budget in Meta Ads Manager. I don't touch your ad account.`
  )
}
