-- Rollback (run by hand, not applied by this package):
--   alter table venues drop column if exists focus_keyphrase;
--   alter table events drop column if exists focus_keyphrase;
-- Copied from ThinAirSolutionsBuild schema/004_seo_focus_keyphrase.sql.
-- Adds the remaining Yoast-standard on-page SEO field (focus keyphrase) to
-- the two content types that get auto-generated SEO copy.
-- sites.city and the slug backfill in that file are omitted (events and venues only).

alter table events add column focus_keyphrase text;
alter table venues add column focus_keyphrase text;
