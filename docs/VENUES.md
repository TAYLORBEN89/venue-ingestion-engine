# Pilot venues (handoff catalog)

The HeyAustin **venues table is not in this package**. What shipped is:

1. **Platform adapters** in `engine/src/lib/sources/` (the scrapers).
2. **Per-venue pilot scripts** in `engine/scripts/` (how each venue was wired).
3. **Machine catalog** at [`examples/venues/catalog.json`](../examples/venues/catalog.json) — slug, calendar URL, `platform_type`, script.

Poodie's is the only venue with a standalone packet (`examples/venues/poodies-hilltop/`). Every other venue was driven by a named `pilot-*.mjs` (or a batch/repilot script) against Supabase.

## How the scripts work

Most pilots:

1. Look up the venue **by slug** in Supabase.
2. Write `venues.calendar_url` + a `venue_event_sources` row (`platform_type`, feed/calendar URL).
3. Call the ingestion worker (`/ingest` or `/test-source`) **or** scrape locally and stage `ingested_events`.

Without a `venues` row they exit `Venue not found`. Reseed from `catalog.json`, then run the script.

Run from `engine/` (scripts that read `./.dev.vars` assume that cwd):

```bash
cd engine
node scripts/pilot-docs-bar.mjs --probe-only
node scripts/ingest-venue.mjs the-mohawk
```

See [`engine/scripts/README.md`](../engine/scripts/README.md).

## Dedicated venue pilots

| Slug | Venue | Platform | Script |
|------|-------|----------|--------|
| `poodie-s-hilltop-roadhouse` | Poodie's Hilltop | Outhouse | `pilot-poodies.mjs` + packet |
| `doc-s-bar-and-grill` | Doc's | SpotApps | `pilot-docs-bar.mjs` |
| `the-hideout-theatre` | Hideout Theatre | Events Manager | `pilot-hideout.mjs` |
| `the-velveeta-room` | Velveeta Room | SeatEngine | `pilot-velveeta-room.mjs` |
| `speakeasy` | Speakeasy | EventON | `pilot-speakeasy.mjs` |
| `the-mohawk` | Mohawk | Prekindle | `pilot-mohawk.mjs` |
| `hole-in-the-wall` | Hole in the Wall | Prekindle | `pilot-hole-in-the-wall.mjs` |
| `cap-city-comedy-club` | Cap City Comedy | SeatEngine | `pilot-cap-city.mjs` |
| `the-carousel-lounge` | Carousel Lounge | TEC | `pilot-carousel-lounge.mjs` |
| `san-jac-saloon` | San Jac Saloon | Google Calendar ICS | `pilot-san-jac.mjs` |
| `frontyard-brewing` | Frontyard Brewing | Squarespace | `pilot-frontyard.mjs` |
| `vista-brewing` | Vista Brewing | Squarespace | `pilot-vista.mjs` |
| `jester-king` | Jester King | Spacecrafted | `pilot-jester-king.mjs` |
| `moontower-saloon` | Moontower Saloon | SpotApps | `pilot-moontower.mjs` |
| `germania-insurance-amphitheater` | Germania Amp | custom HTML | `pilot-germania-amp.mjs` |
| `circuit-of-the-americas` | COTA | custom HTML | `pilot-cota.mjs` |
| `vulcan-gas-company` | Vulcan | Webflow | `pilot-vulcan.mjs` |
| `flamingo-cantina` | Flamingo Cantina | TEC | `pilot-flamingo-cantina.mjs` |
| `come-and-take-it-live` | CATI Live | RHP | `pilot-cati-live.mjs` |
| `the-long-center` | Long Center | EventON | `pilot-long-center-full.mjs` |
| `acl-live` | ACL Live / 3TEN | AXS | `pilot-acl-events-full.mjs` |

## Batch / re-pilot (same idea, several venues)

| Venues | Script |
|--------|--------|
| Germania Amp, Friends Bar, ACL Live | `pilot-batch-new.mjs` |
| White Horse, Friends Bar, Hole in the Wall | `pilot-batch-round2.mjs` |
| ACL Live, Cactus Cafe, Coupland, Moontower, Vulcan, Celis | `pilot-batch-round3.mjs` |
| Long Center, Donn's Depot, ACL Live 3TEN | `pilot-batch-round4.mjs` |
| Guero's, Donn's, Vulcan | `pilot-batch-round5.mjs` |
| Saxon Pub, Elephant Room, Scoot Inn, Esther's Follies | `repilot-venues.mjs` |
| Saxon Pub TEC crawl | `saxon-full-calendar.mjs` |

## Completed via generic pipeline (no dedicated ingest script)

Moody Center, Moody Amphitheater, Meanwhile Brewing, Hotel Vegas, Stubb's, Antone's, Buck's Backyard — listed in `engine/scripts/lib/pilot-venue-filters.mjs`. Probe/debug scripts remain under `engine/scripts/probe-*`.

Lake Travis venue import: `import-listar-laketravis-venues.mjs`.

## What was intentionally not copied

- `tmp-*` HTML/JSON research dumps
- Cookie jars
- Minified third-party page bundles (`ace-calendar.js`)
- Live `venues` / `events` row dumps
