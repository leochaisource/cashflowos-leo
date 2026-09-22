-- THE ARCHIVE — run once in the Supabase SQL editor.
--
-- Everything the 8am run computes used to be thrown away the moment the
-- Telegram message was sent: the performance block was rendered from live
-- Meta + GoHighLevel calls and never written down, the Adyntel credits were
-- spent and only the ads kept, and the opt-ins stayed in someone else's CRM.
-- That means no history, no "what did we spend to get last month's sales", and
-- no way to check a number after the fact.
--
-- These six tables are the memory. Each one is idempotent on a natural key, so
-- re-running a day CORRECTS it instead of duplicating it — the same rule
-- ad_daily already follows, and the reason the cron can safely re-pull the
-- trailing week while Meta restates its attributed conversions.
--
--   funnel_daily      per funnel, per day: spend, leads and CPL
--   brief_daily       per client, per day: the exact block sent, and to whom
--   adyntel_runs      what each competitor search cost and what it found
--   ghl_leads         every individual opt-in, by form
--   ghl_sales         every individual purchase, with seats
--   project_registry  a readable mirror of lib/ad-clients.ts

-- ---------------------------------------------------------------- performance
-- One row per client per funnel per day. This is the time series behind every
-- "is the webinar route still cheaper than the direct ticket" question.
create table if not exists funnel_daily (
  id            bigint generated always as identity primary key,
  project       text        not null,   -- matches the id in lib/ad-clients.ts
  date          date        not null,   -- the day the figures cover, ad-account timezone
  funnel        text        not null,   -- "Webinar Funnel"
  campaign      text,                   -- the Meta campaign that pays for it
  spend         numeric     not null default 0,
  -- NULL ≠ 0 throughout: null means the source could not be read, 0 means it
  -- was read and nobody opted in. A brief that reports a silent outage as a
  -- day of zero leads is worse than one that admits it does not know.
  leads         integer,                -- GHL form submissions
  cpl           numeric,
  form_id       text,
  form_name     text,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create unique index if not exists funnel_daily_key_idx
  on funnel_daily (project, date, funnel);
create index if not exists funnel_daily_project_idx
  on funnel_daily (project, date desc);

-- One row per client per day: the message that went out, verbatim, plus the
-- cumulative figures and the delivery result. Keeping the rendered text means a
-- disagreement about what the client was told is settled by reading the row.
create table if not exists brief_daily (
  id               bigint generated always as identity primary key,
  project          text        not null,
  date             date        not null,   -- the day the FIGURES cover, not the send date
  sent_at          timestamptz not null default now(),
  performance_text text,                   -- the exact block the client group received
  report_text      text,                   -- the written analysis (operator copy only)
  purchases_today  integer,
  purchases_total  integer,
  sales_since      date,
  spend_total      numeric,
  spend_since      date,
  cost_per_sale    numeric,
  recipients       text[],
  delivered        text[],
  failed           jsonb,
  notes            text[],
  payload          jsonb,                  -- the whole computed block, for replay
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create unique index if not exists brief_daily_key_idx
  on brief_daily (project, date);
create index if not exists brief_daily_project_idx
  on brief_daily (project, date desc);

-- ---------------------------------------------------------------- competitors
-- What each morning's competitor research cost and what it returned. The ADS
-- themselves live in competitor_ads; this is the accounting and the provenance,
-- so "why did we spend 300 credits last month" has an answer.
create table if not exists adyntel_runs (
  id              bigint generated always as identity primary key,
  project         text        not null,
  date            date        not null,
  searches        jsonb,                  -- [{keyword, country}] actually run
  watch_page      text,                   -- the brand pulled in full, if any
  credits         integer     not null default 0,
  ads_seen        integer,
  ads_stored      integer,
  advertisers     integer,
  concepts        integer,
  new_concepts    integer,
  new_variations  integer,
  partial         text[],                 -- searches that hit the page cap
  created_at      timestamptz not null default now()
);
create unique index if not exists adyntel_runs_key_idx
  on adyntel_runs (project, date);
create index if not exists adyntel_runs_project_idx
  on adyntel_runs (project, date desc);

-- ---------------------------------------------------------------- leads
-- Every individual opt-in. Counting is already done in funnel_daily; this is
-- the list behind the count — who actually came in, from which form, so a name
-- can be looked up months later without asking the CRM.
create table if not exists ghl_leads (
  id            bigint generated always as identity primary key,
  project       text        not null,
  submission_id text        not null,   -- GHL form submission id
  contact_id    text,
  form_id       text,
  form_name     text,
  name          text,
  email         text,
  phone         text,
  submitted_at  timestamptz not null,
  payload       jsonb,
  created_at    timestamptz not null default now()
);
create unique index if not exists ghl_leads_key_idx
  on ghl_leads (project, submission_id);
create index if not exists ghl_leads_project_idx
  on ghl_leads (project, submitted_at desc);
create index if not exists ghl_leads_form_idx
  on ghl_leads (project, form_id, submitted_at desc);

-- ---------------------------------------------------------------- sales
-- Every purchase, with SEATS — a RM794 line is two people, and the seat count
-- is what fills a room. Upsells are kept (is_upsell) rather than dropped, so
-- revenue and head count can both be answered from the same table.
create table if not exists ghl_sales (
  id             bigint generated always as identity primary key,
  project        text        not null,
  transaction_id text        not null,
  order_id       text,
  contact_id     text,
  contact_name   text,
  contact_email  text,
  amount         numeric,
  currency       text,
  seats          integer,
  source_name    text,                   -- the funnel/product that sold it
  is_upsell      boolean     not null default false,
  status         text,
  paid_at        timestamptz not null,
  payload        jsonb,
  created_at     timestamptz not null default now()
);
create unique index if not exists ghl_sales_key_idx
  on ghl_sales (project, transaction_id);
create index if not exists ghl_sales_project_idx
  on ghl_sales (project, paid_at desc);

-- ---------------------------------------------------------------- projects
-- A readable mirror of lib/ad-clients.ts, refreshed on every run.
--
-- The CODE remains the source of truth — this table is deliberately a snapshot,
-- never read back by the app, so the two cannot drift into disagreeing about
-- which one is right. It exists so the registry can be queried alongside the
-- data it describes.
create table if not exists project_registry (
  id           bigint generated always as identity primary key,
  project      text        not null,
  name         text,
  client       text,
  stage        text,
  rank         integer,
  currency     text,
  countries    text[],
  target_cpl   numeric,
  meta_ready   boolean,                -- both Meta env vars present
  ghl_ready    boolean,                -- both GHL env vars present
  config       jsonb,                  -- the whole entry, minus anything secret
  synced_at    timestamptz not null default now()
);
create unique index if not exists project_registry_key_idx
  on project_registry (project);
