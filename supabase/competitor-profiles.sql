-- COMPETITOR PROFILES — run once in the Supabase SQL editor.
--
-- One row per real competitor per project: who they are, where their ads send
-- people, and what they are selling and why a buyer would pick them.
--
-- competitor_ads already holds every ad; this is the layer a person reads. It is
-- built FROM the ads (scripts/competitor-profiles.ts, and the 8am run for the
-- advertisers it just saw) so the Competitors tab reads one small table instead
-- of re-scanning thousands of ads on every page view.
--
-- Only ON-TOPIC advertisers get a profile — a furniture shop that happened to
-- use the word "Malaysia" is not a competitor, however many ads it runs.
--
-- Idempotent. Safe to re-run.

create table if not exists competitor_profiles (
  id              bigint generated always as identity primary key,
  project         text        not null,   -- matches the id in lib/ad-clients.ts
  competitor      text        not null,   -- the page name, exactly as competitor_ads has it
  page_id         text,
  page_url        text,                   -- https://www.facebook.com/<page_id>

  -- Where the ads' call-to-action leads, most-used first:
  -- [{ kind: website|whatsapp|messenger|form|instagram|facebook|none, label, url, ads }]
  landings        jsonb       not null default '[]'::jsonb,

  -- What they sell and why a buyer would choose them, in plain English, read
  -- from their ad copy. NULL = not written yet (never "no USP").
  usp             text,
  -- The concrete hook in the ads — a price, a free seat, a discount, a bonus.
  -- NULL = none found or not written yet.
  offer           text,
  -- Could a buyer of the client's offer buy this INSTEAD? Keyword search drags in
  -- software vendors, hardware, conferences and unrelated courses that merely
  -- share a word; they keep a row (the evidence) but the tab hides them by default.
  -- NULL = not judged yet, shown as a competitor.
  is_competitor   boolean,
  usp_source      text,                   -- the model or process that wrote it
  usp_ads         integer,                -- how many of their ads it was read from
  usp_updated_at  timestamptz,

  -- Rolled up from competitor_ads when the profile was last built.
  ads             integer     not null default 0,
  active_ads      integer     not null default 0,
  longest_run     integer,
  first_seen_at   timestamptz,
  last_seen_at    timestamptz,

  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

alter table competitor_profiles add column if not exists is_competitor boolean;

create unique index if not exists competitor_profiles_key_idx
  on competitor_profiles (project, competitor);
create index if not exists competitor_profiles_project_idx
  on competitor_profiles (project, active_ads desc, ads desc);
