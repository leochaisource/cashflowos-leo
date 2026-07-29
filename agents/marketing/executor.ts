// 🔒 DON'T EDIT — this is what keeps your robot safe.
//
// The Head of Marketing shares the gallery agents' DRAFT-ONLY funnel (draftOnly in
// agents/registry.ts). Whether a recommendation was approved in Telegram or in the
// Approvals tab, it runs through that ONE function exactly once (the CAS in
// lib/actions.ts) and produces a piece of text. That's all.
//
// 🔴 NEVER-zone: this head has no connection to your ad account. There is no pause,
//    no boost, no budget change, no spend — not as a disabled setting, but as code
//    that does not exist. Approving its recommendation records your decision; YOU
//    make the change in Meta Ads Manager.

import { EXECUTORS } from '@/agents/registry'

export const execute = (payload: any) => EXECUTORS['marketing-triage'](payload)
