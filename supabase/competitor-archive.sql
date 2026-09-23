-- COMPETITOR RESEARCH ARCHIVE — run once in the Supabase SQL editor.
--
-- The 8am run already keeps every competitor ad it sees (competitor_ads) and
-- what each search cost (adyntel_runs). Two things were still thrown away:
--
--   1. The daily SUMMARY — the facts block the model was given (longest-running
--      concepts, new concepts, hooks shared by several advertisers, data
--      quality) and the full stats behind it. Only the raw ads survived, and
--      you cannot tell from a pile of ads what the morning actually concluded.
--   2. WHICH ads each run returned. first_seen_at/last_seen_at give a range,
--      not a per-day picture; "show me what we found on the 19th" had no answer.
--
-- This migration adds both, scores every ad on-topic/noise at ingest so the
-- library can filter in SQL without pulling raw_payload, and creates the
-- Storage bucket the cron saves creative thumbnails into (Meta's CDN URLs are
-- signed and expire within weeks — an archive whose images go blank is not an
-- archive).
--
-- Everything is idempotent. Safe to re-run.

-- ---------------------------------------------------------------- competitor_ads
-- The relevance verdict, written when the ad is stored. NULL = not scored yet
-- (rows that predate this column; scripts/adyntel-rescore.ts --write fills them).
alter table competitor_ads add column if not exists on_topic boolean;

-- The library's four ways of looking at the pile.
create index if not exists competitor_ads_client_topic_idx on competitor_ads (client, on_topic, last_seen_at desc);
create index if not exists competitor_ads_client_first_idx on competitor_ads (client, first_seen_at desc);
create index if not exists competitor_ads_client_run_idx   on competitor_ads (client, run_days desc nulls last);
create index if not exists competitor_ads_keywords_gin     on competitor_ads using gin (keywords);

-- ---------------------------------------------------------------- adyntel_runs
-- What the model was told, the whole stats object, and the ads that came back.
alter table adyntel_runs add column if not exists facts_text text;    -- competitorSection().text, verbatim
alter table adyntel_runs add column if not exists stats      jsonb;   -- competitorSection().stats, whole
alter table adyntel_runs add column if not exists seen_ids   text[];  -- ad_archive_ids this run returned

-- ---------------------------------------------------------------- facets
-- One request each for the library's chip rows. Aggregated in the database on
-- purpose: PostgREST caps a response at 1,000 rows and Claude Malaysia alone
-- holds more ads than that, so grouping in the page would silently truncate.
-- security_invoker keeps RLS in force for anyone who is not the service role.
create or replace view competitor_ads_advertisers with (security_invoker = on) as
  select
    client,
    competitor,
    max(page_id)                                   as page_id,
    count(*)::int                                  as ads,
    count(*) filter (where is_active)::int         as active,
    count(*) filter (where on_topic)::int          as on_topic,
    max(run_days)                                  as longest_run,
    min(first_seen_at)                             as first_seen_at,
    max(last_seen_at)                              as last_seen_at
  from competitor_ads
  group by client, competitor;

create or replace view competitor_ads_keywords with (security_invoker = on) as
  select
    client,
    k                                              as keyword,
    count(*)::int                                  as ads,
    count(*) filter (where is_active)::int         as active
  from competitor_ads, unnest(keywords) as k
  group by client, k;

-- ---------------------------------------------------------------- storage
-- Thumbnails live here, one per ad, at <client>/<ad_archive_id>.<ext>.
-- PUBLIC on purpose: these are public Meta ads with no personal data in them,
-- and a public bucket lets the page build the image URL without minting a
-- signed link per card. Prefer it behind the passcode? Set public = false and
-- switch lib/competitor-archive.ts thumbUrl() to createSignedUrls().
insert into storage.buckets (id, name, public)
  values ('competitor-creatives', 'competitor-creatives', true)
  on conflict (id) do nothing;
