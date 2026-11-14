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
