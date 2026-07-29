-- ============================================================
-- Multi-client support for competitor_ads.
--
-- Until now one row = one advertiser's ad, with no record of WHOSE brief it
-- belongs to. `competitor` means "the advertiser being watched", not "the client
-- we report to". With a second client watching a completely different market,
-- those have to be separate columns or the two clients' markets merge.
--
-- Safe to run more than once. Existing rows are backfilled to 'dianna-nlp'.
-- Nothing is deleted.
-- ============================================================

alter table competitor_ads add column if not exists client text;

-- Everything already in the table came from Dianna's NLP watch keywords.
update competitor_ads set client = 'dianna-nlp' where client is null;

alter table competitor_ads alter column client set not null;
alter table competitor_ads alter column client set default 'dianna-nlp';

-- The upsert key gains the client: the same competitor ad can legitimately be
-- tracked by two clients (overlapping markets) and must not collide.
alter table competitor_ads drop constraint if exists competitor_ads_competitor_ad_archive_id_key;
create unique index if not exists competitor_ads_client_competitor_ad_idx
  on competitor_ads (client, competitor, ad_archive_id);

create index if not exists competitor_ads_client_idx on competitor_ads (client, is_active, run_days desc);
