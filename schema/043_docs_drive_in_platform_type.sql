-- Allow docs_drive_in platform_type (docsdriveintheatre.com FullCalendar + /api/events).

alter table venue_event_sources drop constraint if exists venue_event_sources_platform_type_check;

alter table venue_event_sources
  add constraint venue_event_sources_platform_type_check
  check (platform_type in (
    'auto',
    'ical',
    'google_calendar',
    'tec',
    'eventon',
    'mec',
    'eventbrite',
    'bandsintown',
    'axs',
    'prekindle',
    'event_discovery',
    'webflow',
    'seatengine',
    'zoogle',
    'livenation',
    'esthers_follies',
    'squarespace_user_items',
    'squarespace_events',
    'ace_calendar',
    'spacecrafted',
    'spotapps',
    'events_manager',
    'outhousetickets',
    'heyaustin',
    'comedy_mothership',
    'docs_drive_in',
    'wordpress',
    'custom_html',
    'scrape'
  ));
