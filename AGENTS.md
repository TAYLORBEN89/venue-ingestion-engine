# AGENTS.md — read this first (AI CLI handoff)

You are applying the **HeyAustin pilot venue-ingestion engine** to another site or platform (e.g. ThinAIR rebuild). This package is **first-party proprietary code assigned to ThinAIR Solutions and subsidiaries** — not open source.

## Mission

1. Understand how partner **venue calendars** are scraped/normalized into a common event shape.
2. Port or reuse **platform adapters** (`engine/src/lib/sources/*`) for the target stack.
3. Wire **venue → source config → fetch → normalize → store/review** for the target site.
4. Do **not** invent a new scrape architecture until you have read the existing pipeline.

## Read order (cold start)

1. `README.md` — what this package is / is not  
2. `AGENTS.md` (this file)  
3. `docs/PORTING.md` — how to apply to another platform  
4. `docs/ARCHITECTURE.md` — pipeline as built  
5. `docs/ADAPTERS.md` — catalog of scrapers that worked in pilot  
6. `docs/CONVENTIONS.md` — hard rules (manual wins, draft-first, site_id)  
7. `docs/ENV.md` — bindings and secrets  
8. Then only the files needed for the task  

## Truth hierarchy

1. **Code under `engine/src`** (what actually runs)  
2. **docs/** in this package  
3. Upstream pilot monorepo (if available) — only if docs conflict  

## Hard product rules (from pilot)

- **Manual / curated events win** over scrape overwrites (`source = manual` must not be clobbered).  
- Prefer **draft / review queue** (`ingested_events`) before public publish.  
- Always stamp **`site_id`** (multi-tenant). Wrong site_id = invisible on public site.  
- Prefer **structured adapters** (ICS, TEC REST, SeatEngine JSON, Squarespace collections) over blind HTML AI scrape.  
- AI scrape is **fallback** (`ENABLE_AI_SCRAPE_FALLBACK`), not the primary path.  
- Do not commit secrets, cookie jars, or raw HTML dumps.  

## Stack (pilot truth)

| Layer | Choice |
|-------|--------|
| Runtime | Cloudflare Worker + Workflows |
| Browser | Cloudflare Browser Run (`BROWSER` binding) |
| AI extract | Cloudflare Workers AI (`AI` binding, Llama) |
| Database | Supabase Postgres (service role on worker) |
| Shape | `PartnerEvent` in `engine/src/lib/normalize.ts` |

## Repository map

```
engine/           Runnable ingestion Worker (src, wrangler, package.json)
  src/index.ts              HTTP entry + triggers
  src/workflows/            VenueIngestionWorkflow + scheduler
  src/lib/sources/          Calendar platform adapters (proven pilot scrapers)
  src/lib/normalize.ts      PartnerEvent common shape
  src/lib/dedup.ts          Match against existing events
  src/lib/extract.ts        Workers AI structured extract
  src/lib/browser.ts        Browser Run helpers
schema/           SQL migrations for sources + ingestion tables
docs/             Architecture, porting, adapters, env, conventions
examples/         Sample venue notes (e.g. poodies-hilltop)
LICENSE / NOTICE  Proprietary; ThinAIR ownership grant
```

## What this package is NOT

- Not the full HeyAustin public web or admin UI  
- Not production secrets or live database dumps  
- Not a guarantee every adapter works for every venue forever (sites change HTML)  
- Not open source (ThinAIR owns first-party rights per LICENSE)  

## When porting to another stack

See `docs/PORTING.md`. Minimum viable port:

1. Keep **adapter modules** + `normalize` + `detect-platform` + `fetch-partner-events`.  
2. Replace Supabase writes with your store **or** keep Supabase.  
3. Replace Workflows with your queue if needed, but preserve step order.  
4. Map `venue_event_sources` fields: `calendar_url`, `event_feed_url`, `platform_type`.  

## Do / don't

| Do | Don't |
|----|--------|
| Read ADAPTERS.md before writing a new scraper | Scrape Facebook Graph as ongoing source |
| Prefer ICS / official JSON APIs | Commit `tmp-*` HTML dumps |
| Preserve PartnerEvent fields | Overwrite `source=manual` events |
| Document new platform_type in schema + detect-platform | Hardcode a single venue into the core pipeline |

## License

ThinAIR Solutions and subsidiaries hold **full ownership and usage rights**. Unauthorized third parties have no license.
