-- Partner event import: feed-first ingestion with deterministic dedup.
-- Maps the WordPress-draft workflow to ingested_events → events(status=draft).

-- Preferred structured feed URL (iCal, Google Calendar export, Eventbrite, etc.)
-- When set, ingestion uses this before calendar_url page scraping.
alter table venues
  add column event_feed_url text,
  add column event_feed_type text check (
    event_feed_type is null or event_feed_type in (
      'auto', 'ical', 'google_calendar', 'eventbrite', 'tec_api', 'scrape'
    )
  );

-- Stable partner identifiers for dedup across import runs.
alter table ingested_events
  add column source_event_id text,
  add column fingerprint text,
  add column source_partner text;

alter table events
  add column source_event_id text,
  add column fingerprint text;

-- partner_import: deterministic feed/parser pipeline (not LLM extraction).
alter table events drop constraint events_source_check;
alter table events add constraint events_source_check check (
  source in ('manual', 'ai_ingested', 'facebook_import', 'user_submitted', 'partner_import')
);

create unique index idx_events_venue_source_event_id
  on events (venue_id, source_event_id)
  where source_event_id is not null and status != 'archived';

create unique index idx_events_venue_fingerprint
  on events (venue_id, fingerprint)
  where fingerprint is not null and status != 'archived';

create index idx_ingested_events_venue_fingerprint
  on ingested_events (venue_id, fingerprint)
  where fingerprint is not null;