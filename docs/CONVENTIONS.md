# Conventions (ingestion)

## Multi-tenant

- Every venue and event row needs correct **`site_id`**.  
- Never assume a single global site.

## Source of truth for published content

| Source | Policy |
|--------|--------|
| Archived, then trash (`deleted_at`) | Skip before any rewrite |
| Published (`status = published`) | Workflow passes `refreshPublished: false`. The row is not rewritten and is never set back to draft |
| `events.source = 'manual'` | **Never overwrite** from scrape |
| Series (`event_series_id` or `source = series_generated`) | **Never overwrite** from scrape |
| `field_sources` `manual` or `series` | That field stays |
| Venue, then artist | Only unlocked fields. Writes never include `status` or `deleted_at` |
| Scrape | May create drafts / ingested_events; publish is a product decision |

## Scrape quality

- Require non-empty **title** and valid **starts_at**.  
- Drop events outside `scrapeDaysAhead` horizon.  
- Prefer partner stable IDs for dedup (SeatEngine, etc.).  
- Ticket URL: prefer official ticket links over venue homepage.

## Code style

- TypeScript strict; no `any` unless unavoidable at HTML boundaries.  
- One platform per file under `sources/`.  
- Export `isX` + `fetchXEvents` naming.  
- Keep network timeouts and max page caps (don't infinite crawl).

## Secrets

- Never commit `.dev.vars`, service role keys, or cookie jars.  
- Use Cloudflare secrets in production.

## Docs

- New platform → update `ADAPTERS.md` + `detect-platform.ts` + schema enum if needed.  
- Behavior change → update ARCHITECTURE if pipeline steps change.
