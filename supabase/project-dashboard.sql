-- ============================================================
-- PROJECT DASHBOARD — the two tables behind the per-project scorecards.
-- Paste this WHOLE block into the Supabase SQL Editor and click Run once.
-- Safe to re-run: create-if-not-exists + add-column-if-not-exists throughout,
-- nothing is ever deleted.
--
-- Why two tables and not `records`:
--   • records is one row per THING you track (a lead, an invoice, a task).
--   • these are one row per MEASUREMENT PER DAY — a time series. Folding a time
--     series into records would make every tab's counts wrong the moment a
--     second day of data arrived.
-- ============================================================

-- ------------------------------------------------------------
-- 1) ad_daily — one row per ad, per day, per project.
--    Written by the 8am cron (and the Refresh button) from the Meta Marketing
--    API. The dashboard reads THIS, never Meta directly, so a page load is a
--    single fast Supabase query instead of a 3-5s API round trip — and you keep
--    a spend history Meta only shows you one window at a time.
-- ------------------------------------------------------------
create table if not exists ad_daily (
  id               bigint generated always as identity primary key,
  project          text        not null,   -- matches the id in lib/ad-clients.ts
  date             date        not null,   -- the DAY the spend happened (Meta's date_start)
  ad_id            text        not null,
  ad_name          text,
  campaign_name    text,
  adset_name       text,
  effective_status text,                   -- ACTIVE | PAUSED | ADSET_PAUSED | ARCHIVED ...
  spend            numeric     not null default 0,
  impressions      bigint      not null default 0,
  reach            bigint      not null default 0,
  clicks           bigint      not null default 0,
  link_clicks      bigint      not null default 0,   -- inline_link_clicks (the CTR that matters)
  leads            numeric     not null default 0,   -- counted with the project's leadActionTypes
  currency         text,
  synced_at        timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

-- Re-syncing a day UPDATES its rows instead of duplicating them. This is what
-- lets the cron re-pull the trailing 7 days every morning: Meta restates
-- attributed conversions for days already past, and yesterday's "3 leads"
-- quietly becomes 5. Without this key you'd double-count instead of correcting.
create unique index if not exists ad_daily_project_date_ad_idx
  on ad_daily (project, date, ad_id);
create index if not exists ad_daily_project_date_idx
  on ad_daily (project, date desc);

-- ------------------------------------------------------------
-- 2) project_funnel — the numbers that don't come from Meta.
--    Leads that opted in on the GHL landing page, who actually ATTENDED, how
--    many booked, how many signed up, how much cash landed. Typed in by hand
--    today; fed automatically once GHL / the master leads sheet are connected
--    (that's what `source` records).
--
--    EVERY metric column is nullable ON PURPOSE:
--      NULL = "nobody has recorded this yet"  → the dashboard shows "—"
--      0    = "we checked, it really is zero" → the dashboard shows 0
--    Defaulting these to 0 would print a confident "ROAS 0.0" for a project
--    whose numbers simply haven't been entered. Never add a default here.
-- ------------------------------------------------------------
create table if not exists project_funnel (
  id             bigint generated always as identity primary key,
  project        text        not null,   -- matches the id in lib/ad-clients.ts
  date           date        not null,   -- the day these numbers belong to
  leads          integer,                -- opted in on the GHL landing page
  attended       integer,                -- master leads sheet, column "Attended"
  appointments   integer,                -- appointments booked
  signups        integer,                -- paid sign-ups / enrolments
  cash_collected numeric,                -- money actually banked for this project
  source         text        not null default 'manual',  -- manual | ghl | sheet
  notes          text,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

-- One row per project per day: entering Tuesday's numbers twice corrects them
-- rather than doubling them.
create unique index if not exists project_funnel_project_date_idx
  on project_funnel (project, date);
create index if not exists project_funnel_project_idx
  on project_funnel (project, date desc);
