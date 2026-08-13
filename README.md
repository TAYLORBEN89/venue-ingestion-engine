# Venue Ingestion Engine (pilot handoff)

**AI-agent-friendly package** of the successful **HeyAustin pilot** venue calendar scrapers and ingestion pipeline, for delivery and migration onto another platform (e.g. ThinAIR rebuild).

| | |
|--|--|
| **Author** | Ben Taylor d/b/a CompEssential |
| **Owner** | **ThinAIR Solutions and subsidiaries** (full ownership + usage — see `LICENSE`) |
| **Source pilot** | `events-platform` / HeyAustin |
| **Runtime** | Cloudflare Workers + Workflows + Browser Run + Workers AI |
| **Data** | Supabase Postgres (service role) |

## Who this is for

1. **ThinAIR engineers** migrating scrapers into a new platform.  
2. **AI CLI agents** (Claude Code, Cursor, Grok, Codex, etc.) that must read, understand, and apply this engine without the full monorepo.

**Start here if you are an agent:** open [`AGENTS.md`](./AGENTS.md), then [`docs/PORTING.md`](./docs/PORTING.md).

## What you get

```
venue-ingestion-engine/
  AGENTS.md                 ← AI cold-start (read first)
  README.md                 ← this file
  LICENSE / NOTICE          ← proprietary + ThinAIR ownership grant
  engine/                   ← Cloudflare Worker app (copy of apps/ingestion)
    src/lib/sources/        ← calendar platform adapters
    src/workflows/          ← venue-ingestion + scheduler
    scripts/                ← per-venue pilot / scrape / ingest scripts
    wrangler.jsonc
    package.json
  schema/                   ← SQL for venues/sources/ingestion (subset)
  docs/
    PORTING.md              ← apply to another site/stack
    ARCHITECTURE.md
    ADAPTERS.md             ← which scrapers exist / when to use them
    VENUES.md               ← every piloted venue + which script
    CONVENTIONS.md
    ENV.md
  examples/venues/          ← catalog.json + Poodie's standalone packet
```

**Venues:** start at [`docs/VENUES.md`](./docs/VENUES.md) and [`examples/venues/catalog.json`](./examples/venues/catalog.json). Scripts live in [`engine/scripts/`](./engine/scripts/).

## What you do **not** get

- Full public website or admin UI  
- Production env secrets  
- Live venue/event database export  
- One-off `tmp-*` research dumps  

## Quick start (same stack as pilot)

```bash
cd engine
npm install
cp .dev.vars.example .dev.vars   # create from docs/ENV.md
npm run typecheck
npm run dev                      # wrangler dev
```

Deploy: `npm run deploy` (Cloudflare account + secrets required).

## Pipeline (one venue run)

```
venue_event_sources row
    → load venue + source
    → fetchPartnerEvents (adapter by platform_type or auto-detect)
    → normalize to PartnerEvent[]
    → filter date window
    → dedup / match existing
    → write ingested_events (review) and/or events
    → optional artist match / enrich / media
```

Entry: `engine/src/workflows/venue-ingestion.ts`  
Fetch router: `engine/src/lib/sources/fetch-partner-events.ts`  
Common shape: `engine/src/lib/normalize.ts`

## Proven adapter families (summary)

See **[`docs/ADAPTERS.md`](./docs/ADAPTERS.md)** for the full list.

| Family | Examples |
|--------|----------|
| Feeds | iCal / Google Calendar ICS |
| WordPress | TEC, EventON, MEC, Events Manager, Event Discovery |
| SaaS calendars | SeatEngine, Prekindle, SpotApps, Spacecrafted, Zoogle, ACE |
| Site builders | Squarespace (user items + events), Webflow |
| Ticketing | LiveNation/Ticketmaster venue pages, Outhouse |
| Custom HTML | Comedy Mothership, Doc's Drive-In, White Horse, COTA, Germania Amp, … |
| Fallback | Browser markdown + Workers AI extract |

## License

**Not open source.** First-party code is assigned to **ThinAIR Solutions and its subsidiaries** with full ownership and usage rights (`LICENSE` §2). Unauthorized parties have no rights.

## Contact

Author: ben@compessential.com  
