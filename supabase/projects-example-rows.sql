-- ============================================================
-- PROJECTS TAB — example rows.
-- Paste into the Supabase SQL Editor and Run once, then open /projects.
-- Safe to re-run: the NOT EXISTS guard means it never duplicates.
--
-- The shape: category = 'project' (a fresh category, so these rows never
-- bleed into the money or funnel numbers), status = active | paused | done,
-- due_date = the deadline, and meta holds the custom fields:
--   • client — who it's for
--   • phase  — what stage it's at (Discovery, Build, Launch, Handover…)
-- Add any other field you want to meta later — no schema change, ever.
-- Edit the titles/clients/dates below to YOUR real projects.
-- ============================================================
insert into records (title, status, amount, category, due_date, notes, meta)
select * from (values
  ('CashFlowOS rollout',      'active', 0::numeric, 'project', date '2026-08-15', null::text,
     '{"client":"Internal","phase":"Build"}'::jsonb),
  ('Client website revamp',   'active', 0::numeric, 'project', date '2026-08-01', null::text,
     '{"client":"Acme Sdn Bhd","phase":"Launch"}'::jsonb),
  ('Ads retainer — Q3',       'active', 0::numeric, 'project', date '2026-09-30', null::text,
     '{"client":"Energivity","phase":"Running"}'::jsonb),
  ('Webinar funnel',          'paused', 0::numeric, 'project', date '2026-07-20', null::text,
     '{"client":"Internal","phase":"On hold"}'::jsonb),
  ('Brand refresh',           'done',   0::numeric, 'project', date '2026-06-30', null::text,
     '{"client":"Acme Sdn Bhd","phase":"Handover"}'::jsonb)
) as v(title, status, amount, category, due_date, notes, meta)
where not exists (
  select 1 from records r where r.category = 'project' and r.title = v.title
);
