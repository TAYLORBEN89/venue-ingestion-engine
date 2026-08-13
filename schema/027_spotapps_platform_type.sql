-- Allow spotapps platform_type (SpotApps / SpotHopper events-holder calendars).

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
    'heyaustin',
    'wordpress',
    'custom_html',
    'scrape'
  ));
