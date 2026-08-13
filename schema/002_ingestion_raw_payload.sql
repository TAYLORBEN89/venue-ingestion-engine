-- Adds room for the full LLM extraction alongside the fields already used
-- for matching/dedup. 001's ingested_events only carries raw_title/
-- raw_date_text/parsed_starts_at/parsed_ends_at — enough to match against
-- existing events, but not enough for a curator to actually review the
-- event (no description/price/ticket_url) or to populate the real `events`
-- row on approval without re-scraping. raw_payload carries the rest of the
-- structured extraction (description, price_text, ticket_url, confidence,
-- source excerpt) as JSON rather than adding more single-purpose columns,
-- since this is a staging table read by the admin portal, not queried by
-- its individual fields the way `events` is.
alter table ingested_events
  add column raw_payload jsonb not null default '{}';
