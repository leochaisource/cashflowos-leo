-- LINKEDIN POSTS — a mirror of Leo's post calendar. Run once in the Supabase SQL editor.
--
-- The posts live as markdown files on the laptop (linkedin/posts/YYYY-MM-DD-slug.md)
-- and those files stay the source of truth for every word. This table is a copy
-- of their frontmatter plus the first line, for two reasons:
--   • the Sunday LinkedIn Ideas agent runs on Vercel and can't read laptop files;
--     it reads the last 30 days from here so it stops pitching repeats;
--   • a backup of the calendar if the laptop folder is ever lost.
--
-- Written ONLY by `npm run linkedin -- sync` (scripts/linkedin.mjs), which also
-- runs after every successful `schedule`. One row per file; re-syncing updates it.
-- A deleted file keeps its row (it's a backup, not a live view).
--
-- Idempotent. Safe to re-run.

create table if not exists linkedin_posts (
  id           bigint generated always as identity primary key,
  file         text        not null unique,  -- the file name, e.g. 2026-10-13-ad-waste.md
  status       text,                         -- draft | approved | scheduled | published | skipped
  slot         timestamptz,                  -- when it goes live. NULL = not slotted yet
  topic        text,                         -- a topic from linkedin/profile.md §6
  hook_type    text,                         -- a type from linkedin/hooks.md
  photo        text,                         -- linkedin/photos/<file>.jpg, or none
  hook         text,                         -- the first line of the post body
  source       text,                         -- the idea, script, case study or URL it came from
  ghl_post_id  text,                         -- set once scheduled in GHL Social Planner
  -- The file's own `created:` date (00:00 MYT), not when the row was inserted:
  -- an unslotted draft counts as recent by when it was written.
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()   -- last sync that wrote this row
);

create index if not exists linkedin_posts_slot_idx on linkedin_posts (slot desc);

-- Same rule as every other table here: server-side only. RLS on, no policies,
-- so the anon key gets nothing and the service-role key (server) bypasses it.
alter table linkedin_posts enable row level security;
