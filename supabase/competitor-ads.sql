-- ============================================================
-- competitor_ads — one row per INDIVIDUAL competitor advertisement.
--
-- Why this exists: the 8am ads brief used to keep only a list of ad IDs in
-- bot_memory.counters.ad_intel_seen, so it could count ads and nothing else.
-- Every piece of copy, every headline, every image and video URL that Adyntel
-- returned was parsed into a 6-field summary and then thrown away.
--
-- Safe to run more than once. Adds nothing to, and removes nothing from, any
-- existing table.
-- ============================================================

create table if not exists competitor_ads (
  id                uuid        primary key default gen_random_uuid(),

  -- identity ------------------------------------------------
  competitor        text        not null,          -- the advertiser (Meta page name)
  page_id           text,                          -- Meta page id
  ad_archive_id     text        not null,          -- Meta's unique id for the ad

  -- our observation window ----------------------------------
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  keywords          text[]      not null default '{}',  -- which watch terms surfaced it

  -- Meta's own dates ----------------------------------------
  meta_start_date   timestamptz,
  meta_end_date     timestamptz,
  is_active         boolean     not null default false,
  run_days          integer,                       -- NULL = genuinely unknown
  run_days_basis    text,                          -- 'active' | 'ended' | 'unknown'

  -- the creative --------------------------------------------
  body_text         text,                          -- primary copy, full length
  body_html         text,                          -- original HTML when Meta sends markup
  title             text,                          -- headline
  caption           text,
  link_description  text,
  cta_text          text,
  cta_type          text,
  link_url          text,                          -- landing page
  display_format    text,                          -- IMAGE | VIDEO | CAROUSEL | MULTI_IMAGES
  publisher_platform text[]     not null default '{}',
  collation_count   integer,                       -- how many variations Meta grouped

  -- media ---------------------------------------------------
  image_urls        text[]      not null default '{}',
  video_urls        text[]      not null default '{}',
  thumbnail_urls    text[]      not null default '{}',
  local_media       jsonb       not null default '[]'::jsonb,  -- downloaded file records

  -- everything else, losslessly ------------------------------
  raw_payload       jsonb       not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- the upsert key: same advertiser + same ad = the same row, updated
  unique (competitor, ad_archive_id)
);

-- Columns added defensively so re-running against an earlier version is safe.
alter table competitor_ads add column if not exists keywords      text[] not null default '{}';
alter table competitor_ads add column if not exists local_media   jsonb  not null default '[]'::jsonb;
alter table competitor_ads add column if not exists body_html     text;
alter table competitor_ads add column if not exists run_days_basis text;

create index if not exists competitor_ads_active_idx    on competitor_ads (is_active, run_days desc);
create index if not exists competitor_ads_last_seen_idx on competitor_ads (last_seen_at desc);
create index if not exists competitor_ads_page_idx      on competitor_ads (competitor);

-- Same rule as every other table here: server-side only. RLS on, no policies,
-- so the anon key gets nothing and the service-role key (server) bypasses it.
alter table competitor_ads enable row level security;
