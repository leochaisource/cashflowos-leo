-- LINKEDIN AUTOPILOT — the weekly posts the cloud writes and schedules on its own
-- (owner's call, 2026-11-07: fully automatic, approved facts only).
--
-- One row per research brief (kind 'research', one per posting week) and one per
-- post (kind 'post', one per slot). The daily cron moves each row along:
--   Saturday  research brief            → research 'ready'
--   Sunday    write + check + pick photos → post 'drafted' (or 'dropped', with the reason)
--   Monday+   draw slides + schedule     → post 'scheduled' (or 'failed', with the reason)
-- The unique indexes make a doubled cron delivery harmless: a second insert for
-- the same week or slot simply finds the row already there.
--
-- Written by agents/linkedin/autopilot.ts. Idempotent. Safe to re-run.

create table if not exists linkedin_autopilot (
  id           bigint generated always as identity primary key,
  week         text        not null,              -- ISO week of the posting days, e.g. 2026-W46
  kind         text        not null check (kind in ('research', 'post')),
  slot         timestamptz,                        -- posts: when it goes live
  status       text        not null,               -- research: ready | failed · post: drafted | scheduled | dropped | failed
  data         jsonb       not null default '{}'::jsonb, -- the brief, or the post: body, comment, slides, photos, checks
  ghl_post_id  text,                               -- set once GHL accepts the post
  note         text,                               -- why it was dropped or failed, in plain words
  attempts     int         not null default 0,     -- scheduling attempts (retried daily while the slot is ahead)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists linkedin_autopilot_research_uq on linkedin_autopilot (week) where kind = 'research';
create unique index if not exists linkedin_autopilot_slot_uq on linkedin_autopilot (slot) where kind = 'post';

-- Server-side only, like every other table here: RLS on, no policies.
alter table linkedin_autopilot enable row level security;
