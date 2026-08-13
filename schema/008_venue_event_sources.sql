-- Venue event sources: one venue can have multiple calendar URLs with per-source settings.
-- Replaces ad-hoc venues.calendar_url / event_feed_url over time (those columns kept for legacy).

create table venue_event_sources (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references venues(id) on delete cascade,
  calendar_url          text not null,
  feed_url              text,
  platform_type         text not null default 'auto' check (platform_type in (
    'auto', 'ical', 'google_calendar', 'tec', 'eventon', 'mec', 'eventbrite',
    'bandsintown', 'axs', 'prekindle', 'wordpress', 'custom_html', 'scrape'
  )),
  scrape_days_ahead     smallint not null default 90 check (scrape_days_ahead between 1 and 365),
  publish_mode          text not null default 'draft' check (publish_mode in ('draft', 'auto_publish')),
  default_category_id   uuid references categories(id) on delete set null,
  timezone              text,
  is_enabled            boolean not null default true,
  last_scrape_at        timestamptz,
  last_scrape_status    text check (last_scrape_status is null or last_scrape_status in ('success', 'error')),
  last_scrape_error     text,
  last_event_imported_at timestamptz,
  last_test_at          timestamptz,
  last_test_result      jsonb not null default '{}',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_venue_event_sources_venue on venue_event_sources (venue_id);
create index idx_venue_event_sources_enabled on venue_event_sources (venue_id) where is_enabled = true;

-- Backfill one source per venue that already has a calendar URL configured.
insert into venue_event_sources (venue_id, calendar_url, feed_url, platform_type)
select
  id,
  calendar_url,
  event_feed_url,
  coalesce(event_feed_type, 'auto')
from venues
where calendar_url is not null
  and not exists (
    select 1 from venue_event_sources s where s.venue_id = venues.id
  );