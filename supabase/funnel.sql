-- ============================================================
-- THE FUNNEL X-RAY (owner, 2026-10-22) — paste once into the Supabase SQL editor.
--
-- One row per lead per event cohort, so the dashboard can show where each lead
-- stopped ("where the ticks stop is where the lead drops"), the stage-to-stage
-- conversion against benchmarks, and which ads bring customers rather than
-- cheap leads. Built nightly by lib/lead-journey.ts; read by the Funnel tab,
-- the 8am brief and the red-stage alert (lib/funnel-report.ts).
--
-- Every stage column is a TIMESTAMP, NULL until the lead reaches that stage.
-- A stage first seen through a GHL tag carries the time it was first noticed,
-- not the moment it happened — the dashboard says so where it matters.
-- ============================================================

create table if not exists lead_journey (
  project      text        not null,   -- the id in lib/ad-clients.ts
  event_date   date        not null,   -- the event this cohort is selling (its window ends that day)
  contact_id   text        not null,
  name         text,
  funnel       text,                   -- the funnel label of their first opt-in in the window
  form_id      text,
  ad_name      text,                   -- utm_content of that opt-in = the Meta ad name
  campaign     text,                   -- utm_campaign of that opt-in
  opted_in_at  timestamptz not null,
  webinar_at   timestamptz,            -- attended a webinar (webinar funnel)
  replied_at   timestamptz,            -- first WhatsApp message from them after opting in
  engaged_at   timestamptz,            -- the AI judged their chat warm or hot
  hot_at       timestamptz,            -- hot: AI label, buying-signal tag or on the closer's list
  called_at    timestamptz,            -- first call logged in the Call Log
  picked_up    boolean,
  checkout_at  timestamptz,            -- started a checkout (failed, pending or paid)
  paid_at      timestamptz,
  seats        integer,
  revenue      numeric,
  attended_at  timestamptz,            -- came to the event (no source yet)
  intent       text,                   -- latest AI label seen
  list_stage   text,                   -- stage of their card on the closer's list
  updated_at   timestamptz not null default now(),
  primary key (project, event_date, contact_id)
);
create index if not exists lead_journey_cohort_idx on lead_journey (project, event_date, opted_in_at desc);

-- The closer's Call Log tab, sent every hour by the hot leads sheet's Apps Script.
-- row_key = a hash of the sheet row, so re-sending the whole log never doubles a call.
create table if not exists call_log (
  project     text        not null,
  row_key     text        not null,
  contact_id  text,
  called_at   timestamptz,
  outcome     text,
  picked_up   boolean,
  attempt     integer,
  called_by   text,
  synced_at   timestamptz not null default now(),
  primary key (project, row_key)
);
create index if not exists call_log_contact_idx on call_log (project, contact_id);

-- Benchmarks the owner typed in. Without a row here a stage's benchmark is the
-- median of the project's finished events (computed, never stored).
create table if not exists funnel_benchmarks (
  project     text        not null,
  funnel      text        not null,   -- 'all' or a funnel label
  rate        text        not null,   -- a rate key from lib/funnel-config.ts
  value       numeric     not null,   -- 0..1
  updated_at  timestamptz not null default now(),
  primary key (project, funnel, rate)
);

-- Lead names live here: same lock as the other tables (the app reads with the service key).
alter table lead_journey enable row level security;
alter table call_log enable row level security;
alter table funnel_benchmarks enable row level security;
