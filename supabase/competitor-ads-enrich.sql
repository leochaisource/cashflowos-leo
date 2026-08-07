-- ============================================================
-- competitor_ads — advertiser context that was arriving on every ad and being
-- thrown away. Paste into the Supabase SQL Editor and Run once.
-- Safe to re-run. Nothing is deleted; existing rows keep NULL until their next
-- fetch fills them in.
--
-- Why these three, out of everything in the payload:
--   • page_like_count  — the only size signal available. The same hook means
--     different things from an 18k-follower coach and a 2M-follower course
--     factory, and the brief could not tell them apart.
--   • page_categories  — Meta's own classification of the advertiser ("Coach",
--     "Education"), free of charge, useful for spotting who is actually a peer.
--   • page_profile_uri — so you can open the advertiser without searching.
-- ============================================================

alter table competitor_ads add column if not exists page_like_count  bigint;
alter table competitor_ads add column if not exists page_categories  text[];
alter table competitor_ads add column if not exists page_profile_uri text;

-- Ranking "who matters in this market" is a follower-count sort over the
-- client's active ads, so index for it.
create index if not exists competitor_ads_client_likes_idx
  on competitor_ads (client, is_active, page_like_count desc);
