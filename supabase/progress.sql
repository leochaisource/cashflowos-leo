-- CLIENT PROGRESS (owner, 2026-11-10). What got done for each client, from
-- Code sessions (claude-mem summaries, sorted by Claude), claude.ai / Cowork
-- chats (the dashboard connector) and Telegram notes. The to-dos themselves stay
-- `records` tasks; this is the "done" log, kept out of `records` because
-- getRecords() reads one page and a log grows fast. See lib/progress.ts.

create table if not exists public.progress_log (
  id           bigint generated always as identity primary key,
  project      text        not null,             -- dashboard id: ad client id or work-project slug
  happened_at  timestamptz not null,
  happened_on  date        not null,             -- KL work day (rolls over at 04:00, lib/format.ts workDay)
  text         text        not null check (char_length(text) <= 300),
  text_key     text        not null,             -- normalised text: the same line logged twice is one row
  source       text        not null check (source in ('code', 'chat', 'telegram')),
  source_ref   text,                             -- mem:<session>:<epoch> · chat · tg:<message id>
  session_ref  text,                             -- the Code session a line came from (dedupe across its chunks)
  created_at   timestamptz not null default now(),
  unique (project, happened_on, text_key)
);
create index if not exists progress_log_project_at on public.progress_log (project, happened_at desc);
create index if not exists progress_log_at on public.progress_log (happened_at desc);

-- One row per claude-mem summary chunk the laptop has sent. Inserting the row is
-- the claim, so two overlapping sync runs never sort the same chunk twice. Raw
-- summary text is never stored here — only what happened to it.
create table if not exists public.progress_ingest (
  ref          text        primary key,          -- mem:<memory_session_id>:<created_at_epoch>
  session_ref  text        not null,
  status       text        not null check (status in ('processing', 'done', 'skipped', 'unsure', 'error')),
  project      text,
  confidence   text,
  note         text,                             -- why skipped / unsure, in a few words
  attempts     int         not null default 0,
  last_error   text,
  item_at      timestamptz not null,
  claimed_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists progress_ingest_status on public.progress_ingest (status, processed_at desc);

-- Server-only, like every other table: RLS on with no policies.
alter table public.progress_log enable row level security;
alter table public.progress_ingest enable row level security;
