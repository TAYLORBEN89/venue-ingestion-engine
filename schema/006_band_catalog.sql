-- Copied from ThinAirSolutionsBuild schema/006_band_catalog.sql.
-- Band catalog enrichment for music-event ingestion.
-- Scraper pulls venue/date/tickets; matcher fills image, bio, YouTube, SEO from artists.

alter table artists
  add column aliases text[] not null default '{}',
  add column seo_title text,
  add column seo_description text,
  add column focus_keyphrase text;

-- youtube stored in social_links.youtube (see admin artist form).

alter table ingested_events
  add column extracted_band_name text,
  add column matched_artist_id uuid references artists(id) on delete set null,
  add column artist_match_status text check (
    artist_match_status is null or artist_match_status in ('matched', 'unmatched', 'ambiguous')
  );

create index idx_artists_site_name on artists (site_id, lower(name));
