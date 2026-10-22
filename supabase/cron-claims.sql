-- One row per scheduled cron run, so a duplicate delivery of the same run does
-- nothing (see lib/cron-claim.ts). Key: '<cron name>:<Malaysia date>'.
create table if not exists public.cron_claims (
  key        text        primary key,
  claimed_at timestamptz not null default now()
);

-- Server-only, like every other table: RLS on with no policies, so the public
-- key reads nothing and only the service_role key (the app) gets in.
alter table public.cron_claims enable row level security;
