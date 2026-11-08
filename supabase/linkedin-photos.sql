-- LINKEDIN PHOTOS — the catalogue of Leo's own photos for the LinkedIn autopilot
-- (owner, 2026-11-08: "a folder where I will continuously upload new portraits ...
-- you gauge which portrait photo is suitable to use, don't be afraid to use the old
-- photos if more relevant").
--
-- The photos live in Leo's Google Drive ("LinkedIn engine/Photos of me (drop new ones
-- here)"), read through the sheet's Apps Script (apps-script/linkedin-sources.gs).
-- Each new photo is looked at once by Claude and described here; the Monday step then
-- picks a cover from these descriptions when one of his photos fits the post better
-- than a stock photo. No photo is stored here, only what it shows.
--
-- Written by agents/linkedin/photos.ts. Idempotent. Safe to re-run.

create table if not exists linkedin_photos (
  drive_id        text primary key,                  -- the file in Leo's Drive
  name            text        not null,
  folder          text        not null default '',   -- subfolder inside the photos folder ('' = top level)
  md5             text        not null default '',   -- a changed file is looked at again
  width           int,
  height          int,
  taken           text,                              -- when the camera says it was taken, as Drive gives it
  added_at        timestamptz,                       -- when it landed in Drive
  in_drive        boolean     not null default true, -- false once Leo deletes it from the folder
  usable          boolean     not null default false,-- Leo, clearly, and fine for a professional post
  cover_ok        boolean     not null default false,-- also works full-bleed behind a headline
  reject_reason   text,                              -- why not, in plain words
  scene           text,                              -- what it shows
  mood            text,
  fits            text,                              -- the kinds of post it suits
  focus_x         real,                              -- where his face is, 0..1 from the left
  focus_y         real,                              -- and 0..1 from the top
  used_count      int         not null default 0,
  last_used_slot  timestamptz,
  catalogued_at   timestamptz not null default now()
);

-- Server-side only, like every other table here: RLS on, no policies.
alter table linkedin_photos enable row level security;
