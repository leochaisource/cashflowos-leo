-- THE AI LIBRARY (owner, 2026-11-10): real-life cases of how people build AI agents
-- and use AI in their business, found by the researcher (agents/ai-library/) on
-- Tue–Fri mornings, plus the 3 Saturday ideas built from them for Leo's own setup.
-- Read on /library and by Jarvis (library_search). Server-only: the app uses the
-- service role, so RLS is on with no policies (nothing public can read it).
--
-- Applied 2026-11-10 through the Supabase MCP (migration "ai_library"). Kept here
-- as the record; every statement is safe to run again.

create table if not exists public.ai_library (
  id bigint generated always as identity primary key,
  url text not null,
  url_key text not null unique,              -- normalised URL, so the same page is never stored twice
  title text not null,
  publisher text,
  published_on text,                         -- as the page shows it ("date not shown" allowed)
  who text,                                  -- the company or person the case is about
  region text,
  company_size text check (company_size in ('solo', 'small', 'mid', 'enterprise', 'unknown')),
  topics text[] not null default '{}',       -- marketing-sales | ops-finance-admin | solo-small-team | malaysia-sea
  business_function text,
  pattern text,                              -- the agent pattern in a few words
  tools text[] not null default '{}',
  summary text not null,
  how_it_works text[] not null default '{}',
  results jsonb not null default '[]',       -- [{claim, number, claimed_by, excerpt}]
  lessons text[] not null default '{}',
  apply_idea text,                           -- how Leo could use it
  relevance smallint check (relevance between 1 and 5),
  source_kind text,
  excerpts text[] not null default '{}',     -- word-for-word lines from the page
  check_status text not null default 'unchecked' check (check_status in ('verified', 'partly', 'unchecked')),
  check_note text,
  found_by text not null default 'manual',   -- research:<focus> | manual
  keywords text not null default '',         -- tools + tags, space-joined, for search
  fts tsvector generated always as (
    to_tsvector(
      'english'::regconfig,
      coalesce(title, '') || ' ' || coalesce(who, '') || ' ' || coalesce(pattern, '') || ' ' ||
      coalesce(summary, '') || ' ' || coalesce(business_function, '') || ' ' ||
      coalesce(apply_idea, '') || ' ' || keywords
    )
  ) stored,
  created_at timestamptz not null default now()
);
create index if not exists ai_library_fts_idx on public.ai_library using gin (fts);
create index if not exists ai_library_created_idx on public.ai_library (created_at desc);

-- The Saturday ideas: 3 a week, each citing the library cases it came from.
-- Leo's answer lives on the agent_actions row (action_id): executed = wanted,
-- rejected = not for me, expired = no answer.
create table if not exists public.ai_library_suggestions (
  id bigint generated always as identity primary key,
  week text not null,                        -- ISO week of the Saturday, e.g. 2026-W46
  position smallint not null,
  kind text not null check (kind in ('improve', 'build', 'try')),
  title text not null,
  what text not null,
  why text not null,
  first_step text not null,
  effort text,
  improves text,                             -- the existing automation it improves, if any
  based_on bigint[] not null default '{}',   -- ai_library ids
  status text not null default 'suggested' check (status in ('suggested', 'wanted', 'not_for_me', 'done')),
  action_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week, position)
);

-- One row per run: the dedupe claim (a second kick the same day does nothing) and
-- the record Saturday's card reads to say how the week's research went.
create table if not exists public.ai_library_runs (
  key text primary key,                      -- <step>:<KL date>, e.g. research:2026-11-11
  step text not null check (step in ('research', 'suggest')),
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  focus text,
  added int not null default 0,
  notes jsonb not null default '[]',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.ai_library enable row level security;
alter table public.ai_library_suggestions enable row level security;
alter table public.ai_library_runs enable row level security;
