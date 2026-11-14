-- Rollback (run by hand, not applied by this package):
--   alter table events drop column if exists seo_description;
--   alter table events drop column if exists seo_title;
--   alter table venues drop column if exists seo_description;
--   alter table venues drop column if exists seo_title;
-- Copied from ThinAirSolutionsBuild schema/003_venue_event_seo_fields.sql.
-- docs/ai-ingestion-pipeline.md describes SEO generation running on
-- events, posts, AND venues, but only `posts` ever got seo_title/
-- seo_description columns. Adding the same pair to venues and events so
-- there's actually somewhere for that (and manual curator edits) to go.
alter table venues
  add column seo_title text,
  add column seo_description text;

alter table events
  add column seo_title text,
  add column seo_description text;
