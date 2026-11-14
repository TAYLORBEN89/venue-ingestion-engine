-- Rollback (run by hand, not applied by this package):
--   alter table ingested_events drop column if exists matched_series_id;
--   drop index if exists events_event_series_id_idx;
--   alter table events drop column if exists event_series_id;
--   drop index if exists event_series_venue_idx;
--   drop index if exists event_series_site_idx;
--   drop table if exists event_series;
-- Copied from ThinAirSolutionsBuild schema/028_event_series.sql.
-- Non-artist recurring series stubs (admin backend).
-- Used for series/event-format names like "Gospel Brunch", "Sing Along Saturdays",
-- "Blue Monday" — NOT artist catalog entries.
--
-- Flow:
--   1. Curator creates a series stub with match patterns + curated description/image/SEO
--   2. Ingestion / approve matches titles to a series
--   3. Published events get event_series_id + stamped curation fields
--   4. Future instances of the same series inherit the stub when empty

create table if not exists event_series (
  id                  uuid primary key default gen_random_uuid(),
  site_id             uuid not null references sites(id) on delete cascade,
  name                text not null,
  slug                text not null,
  -- Title fragments for matching (case-insensitive). Example: {"gospel brunch","gospel brunch w/"}
  match_patterns      text[] not null default '{}',
  -- Optional venue scope: only match at this venue when set
  venue_id            uuid references venues(id) on delete set null,
  description         text,
  event_intro         text,
  featured_media_id   uuid references media(id) on delete set null,
  youtube_id          text,
  youtube_embed       text,
  seo_title           text,
  seo_description     text,
  focus_keyphrase     text,
  seo_score_json      jsonb,
  quality_status      jsonb,
  -- Which fields to stamp onto matched events when empty (never overwrites manual/artist-sourced)
  apply_description   boolean not null default true,
  apply_event_intro   boolean not null default true,
  apply_image         boolean not null default true,
  apply_seo           boolean not null default true,
  apply_youtube       boolean not null default false,
  notes               text, -- internal curator notes
  status              text not null default 'published'
                        check (status in ('draft', 'published')),
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (site_id, slug)
);

create index if not exists event_series_site_idx
  on event_series (site_id)
  where deleted_at is null;

create index if not exists event_series_venue_idx
  on event_series (venue_id)
  where venue_id is not null and deleted_at is null;

comment on table event_series is
  'Non-artist recurring series stubs for ingestion pairing + curation (Gospel Brunch, Sing Along Saturdays, …).';

-- Link published events → series stub
alter table events
  add column if not exists event_series_id uuid references event_series(id) on delete set null;

create index if not exists events_event_series_id_idx
  on events (event_series_id)
  where event_series_id is not null;

comment on column events.event_series_id is
  'Matched non-artist recurring series stub (admin curation / ingestion pairing).';

-- Ingestion staging
alter table ingested_events
  add column if not exists matched_series_id uuid references event_series(id) on delete set null;

comment on column ingested_events.matched_series_id is
  'Suggested event_series match from title/series patterns (non-artist).';
