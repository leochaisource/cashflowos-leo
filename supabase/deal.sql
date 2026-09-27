-- YOUR SHARE — the Claude Malaysia deal tracker. Run once in the Supabase SQL editor.
--
-- Leo is paid per event from two pools (Marketing Collaboration Agreement,
-- Schedule 2): 60% of the Ads Pool and 20% of the Organic Pool. Which pool a
-- seat falls in is decided by its FIRST TOUCH (clause 6) — so the tracker needs
-- the seat split, the ad spend and the ticket revenue, every day.
--
-- Idempotent. Safe to re-run.

-- ① The House's own daily seat split — Kingsley's EventOps report (payment
-- records + community join dates: what the event statement is settled on).
-- Posted to /api/eventops by his cron. One row per event per report day; a
-- re-send the same day corrects it.
create table if not exists house_reports (
  id                bigint generated always as identity primary key,
  project           text        not null,
  event_date        date        not null,
  report_date       date        not null,
  paid              integer,
  target            integer,
  ads_confirmed     integer,
  organic_confirmed integer,
  unknown           integer,
  general           integer,
  vip               integer,
  affiliate_seats   integer,
  ads_revenue       numeric,
  organic_revenue   numeric,
  raw               jsonb       not null default '{}'::jsonb,
  received_at       timestamptz not null default now()
);
create unique index if not exists house_reports_key_idx on house_reports (project, event_date, report_date);

-- ② The estimate as it stood each morning — what the 8am brief said, and why.
-- One row per project per day (re-running a day overwrites it).
create table if not exists deal_daily (
  id          bigint generated always as identity primary key,
  project     text        not null,
  date        date        not null,
  event_no    integer,
  event_date  date,
  source      text,                       -- 'eventops' | 'ghl-estimate'
  inputs      jsonb       not null default '{}'::jsonb,
  result      jsonb       not null default '{}'::jsonb,
  text        text,                       -- the block exactly as sent
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create unique index if not exists deal_daily_key_idx on deal_daily (project, date);

-- ③ Our own fallback when no EventOps report is in: each buyer's first touch,
-- read from GoHighLevel (attributionSource + date added). 'ads' | 'organic' | 'unknown'.
alter table ghl_sales add column if not exists seat_source      text;
alter table ghl_sales add column if not exists source_reason    text;
alter table ghl_sales add column if not exists contact_added_at timestamptz;
