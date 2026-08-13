# Architecture — venue ingestion (pilot as-built)

## High level

```
                    ┌─────────────────────┐
  Cron / HTTP  ───► │ IngestionScheduler  │
                    │  or admin trigger   │
                    └──────────┬──────────┘
                               │ per venue source
                               ▼
                    ┌─────────────────────┐
                    │ VenueIngestionWorkflow
                    │  (Cloudflare Workflow)
                    └──────────┬──────────┘
                               │
         load venue + venue_event_sources
                               │
                               ▼
                    ┌─────────────────────┐
                    │ fetchPartnerEvents  │
                    │  platform adapters  │
                    └──────────┬──────────┘
                               │ PartnerEvent[]
                               ▼
              filter window → dedup → enrich
                               │
                               ▼
              ingested_events / events (Supabase)
```

## Main modules

| Path | Role |
|------|------|
| `engine/src/index.ts` | Worker HTTP API: trigger runs, health, artist helpers |
| `engine/src/workflows/venue-ingestion.ts` | Durable multi-step scrape for one venue/source |
| `engine/src/workflows/scheduler.ts` | Fan-out scheduled pilots |
| `engine/src/lib/sources/fetch-partner-events.ts` | **Router** — picks adapter |
| `engine/src/lib/sources/detect-platform.ts` | HTML/URL → platform_type |
| `engine/src/lib/sources/*.ts` | Per-platform fetchers |
| `engine/src/lib/normalize.ts` | PartnerEvent type + mappers |
| `engine/src/lib/dedup.ts` | Match scraped rows to existing events |
| `engine/src/lib/extract.ts` | Workers AI JSON extraction fallback |
| `engine/src/lib/browser.ts` | Browser Run → markdown/HTML |
| `engine/src/lib/supabase.ts` | Service-role client |

## Runtime bindings (`wrangler.jsonc`)

| Binding | Type | Use |
|---------|------|-----|
| `BROWSER` | Browser Run | JS-rendered calendars |
| `AI` | Workers AI | Structured extract fallback |
| `VENUE_INGESTION_WORKFLOW` | Workflow | Per-venue run |
| `SCHEDULER_WORKFLOW` | Workflow | Batch schedule |
| Secrets | env | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optional Ticketmaster, etc. |

## Data flow details

1. **Create** `ingestion_runs` row (`status=running`).  
2. **Fetch** partner events (adapter).  
3. **Validate** title + date window (`scrapeDaysAhead`).  
4. **Match** existing events (URL, partner id, fuzzy title+time).  
5. **Write** review queue and/or update drafts.  
6. Optional: artist catalog match, media upload, SEO fields.  
7. **Finish** run with counts/errors.  

## Why adapters beat generic scrape

Venue sites use known CMS/ticketing platforms. Structured endpoints (ICS, `?rest_route=`, SeatEngine JSON, Squarespace collection APIs) are stable and cheap. Generic HTML+AI is slower, flakier, and costlier — keep as fallback only.

## Multi-tenant

Every venue belongs to a `site_id`. Ingestion must never write events under the wrong site. Public sites filter by `site_id`; mistakes look like “scrape worked but nothing shows.”
