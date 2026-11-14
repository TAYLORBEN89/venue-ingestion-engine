-- Copied from ThinAirSolutionsBuild schema/019_artist_enrichment_fields.sql.
-- Artist enrichment: field provenance on events + richer event_artists links.
-- Public event title remains venue-sourced; these support admin UX + multi-artist.

-- Provenance map: title/description/image/youtube/seo/... → venue | artist | manual | generated
alter table events
  add column if not exists field_sources jsonb not null default '{}'::jsonb;

comment on column events.field_sources is
  'Per-field source: venue | artist | manual | generated. Title must remain venue unless manual.';

-- Multi-artist billing on the join table
alter table event_artists
  add column if not exists billing_order smallint not null default 0,
  add column if not exists role text not null default 'headliner'
    check (role in ('headliner', 'support', 'opener', 'special_guest', 'host', 'tribute'));

create index if not exists event_artists_event_order_idx
  on event_artists (event_id, billing_order);
