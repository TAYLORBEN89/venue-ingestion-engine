# Adapter catalog (pilot scrapers)

**Router:** `engine/src/lib/sources/fetch-partner-events.ts`  
**Detect:** `engine/src/lib/sources/detect-platform.ts`  
**Types:** `PlatformType` in `detect-platform.ts`

Set `venue_event_sources.platform_type` explicitly when known; use `auto` to detect from HTML/URL.

## Feed-based

| platform_type | File | Notes |
|---------------|------|--------|
| `ical` | `ical.ts` | ICS / webcal |
| `google_calendar` | via ical path | Public Google Calendar ICS |

## WordPress family

| platform_type | File | Notes |
|---------------|------|--------|
| `tec` | `tec.ts` | The Events Calendar |
| `eventon` | `eventon.ts` | EventON |
| `mec` | `mec.ts` | Modern Events Calendar |
| `events_manager` | `events-manager.ts` | Events Manager |
| `event_discovery` | `event-discovery.ts` | Event Discovery plugin |
| `wordpress` | generic path | Last resort WP |

## SaaS / ticketing calendars

| platform_type | File | Notes |
|---------------|------|--------|
| `seatengine` | `seatengine.ts` | Strong pilot results; partner event ids |
| `prekindle` | `prekindle.ts` | Organizer calendars |
| `spotapps` | `spotapps.ts` | Listing / pinboard |
| `spacecrafted` | `spacecrafted.ts` | Spacecrafted events |
| `zoogle` | `zoogle-calendar.ts` | Zoogle |
| `ace_calendar` | `ace-calendar.ts` | ACE LIST layout |
| `outhousetickets` | `outhousetickets.ts` | Outhouse venue grid |
| `livenation` | `livenation.ts` | LN / Ticketmaster venue pages |
| `eventbrite` | detect only / partial | Prefer official feeds when possible |
| `bandsintown` | detect | Widget/API patterns |
| `axs` | detect | AXS |

## Site builders

| platform_type | File | Notes |
|---------------|------|--------|
| `squarespace_user_items` | `squarespace-user-items.ts` | User Items List |
| `squarespace_events` | `squarespace-events.ts` | Events collection |
| `webflow` | `webflow-events.ts` | Webflow CMS lists |

## Brand / venue-specific (pilot)

| platform_type | File | Notes |
|---------------|------|--------|
| `heyaustin` | `heyaustin.ts` | Listar/HeyAustin origin (legacy) |
| `laketravis` | `laketravis.ts` | Lake Travis Listar |
| `comedy_mothership` | `comedy-mothership.ts` | /shows grid |
| `docs_drive_in` | `docs-drive-in.ts` | FullCalendar + API |
| `white_horse` | `white-horse.ts` | White Horse Austin |
| `germania_amp` | `germania-amp.ts` | Germania Amphitheater |
| `cota` | `cota-events.ts` | Circuit of The Americas |
| `vulcan_atx` | `vulcan-atx.ts` | Vulcan Gas Company |
| `esthers_follies` | `esthers-follies.ts` | Recurring revue |

## Fallback

| platform_type | Path | Notes |
|---------------|------|--------|
| `scrape` / AI | `browser.ts` + `extract.ts` | Markdown via Browser Run → Workers AI JSON |
| `custom_html` | generic | Prefer writing a real adapter |

## Order of detection (important)

`fetch-partner-events.ts` checks **specific venues and platforms before generic feeds**. When adding adapters, insert **above** generic ICS/HTML fallbacks.

## How to choose for a new venue

1. Open calendar URL in browser → View Source / Network.  
2. Look for `.ics`, `wp-json`, `seatengine`, `squarespace`, `webflow`, ticket iframes.  
3. Match row in this table → set `platform_type`.  
4. If unknown → `auto` once; then lock the detected type.  
5. If empty results → capture HTML sample (do not commit secrets) and extend adapter.

## Pilot success note for agents

These adapters ran in production-style pilot ingestion against real Austin venues. Sites change; treat failures as adapter bugs or markup drift, not “start over.”
