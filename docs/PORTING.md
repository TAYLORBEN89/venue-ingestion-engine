# Porting this engine to another platform

**Audience:** AI agents and engineers rebuilding on ThinAIR (or any new site).

## Goal

Reuse **what worked in the HeyAustin pilot**: platform detection, calendar adapters, normalization to a single event DTO, then **write into your store**.

You do **not** need the full Next.js web/admin apps to get value from this package.

## Two port strategies

### A) Lift-and-shift (fastest)

Keep Cloudflare Worker + Supabase.

1. Create new CF Worker project; copy `engine/` as the app root.  
2. Apply `schema/` migrations (or equivalent tables) on your Supabase project.  
3. Set secrets (`docs/ENV.md`).  
4. Insert `sites`, `venues`, `venue_event_sources` for your market.  
5. Trigger `VenueIngestionWorkflow` per venue/source.  

### B) Adapter library only (integrate into existing backend)

1. Copy `engine/src/lib/sources/*`, `normalize.ts`, `detect-platform.ts`, `fetch-partner-events.ts`, `ical.ts`, `fetch-page.ts`, `discover.ts`, ticket/media helpers as needed.  
2. Provide thin shims for:
   - `browser` (Puppeteer / Playwright / CF Browser)  
   - `ai` (optional structured extract)  
   - HTTP `fetch`  
3. Call `fetchPartnerEvents({ browser, ai, venue, timezone, ... })`.  
4. Map `PartnerEvent` → your DB rows.  

## Minimum data model you must support

| Concept | Pilot table | Purpose |
|---------|-------------|---------|
| Site / tenant | `sites` | timezone, branding, `site_id` |
| Venue | `venues` | place + `site_id` |
| Source | `venue_event_sources` | `calendar_url`, `event_feed_url`, `platform_type`, enabled flags |
| Review queue | `ingested_events` | raw/normalized scrape before publish (recommended) |
| Live shows | `events` | public/curated events; honor `source=manual` |
| Run log | `ingestion_runs` | status, counts, errors |

Field details: see SQL under `schema/`. Platform enum expansions: `023+` migrations.

## PartnerEvent (canonical scrape output)

Defined in `engine/src/lib/normalize.ts`. Adapters **must** produce this shape (or map to it immediately). Typical fields:

- `title`, `starts_at` (ISO), `ends_at?`  
- `venue_name`, `address?`  
- `ticket_url?`, `source_url`  
- `image_url?`, `description?`  
- `source_partner` (platform id string)  
- partner event id when available (SeatEngine id, etc.)  

**Rule:** never invent start times; skip incomplete rows.

## Adding a new venue (ops)

1. Ensure venue exists with correct `site_id`.  
2. Insert `venue_event_sources`:
   - `calendar_url` = public events page  
   - `event_feed_url` = ICS or API if known  
   - `platform_type` = explicit type **or** `auto`  
3. Run ingestion for that `venueId` + `sourceId`.  
4. Inspect `ingested_events` / logs; fix adapter if empty.  

## Adding a new platform adapter

1. Create `engine/src/lib/sources/my-platform.ts` with:
   - `isMyPlatform(url, html)` detector  
   - `fetchMyPlatformEvents(...)` → `PartnerEvent[]`  
2. Register in `fetch-partner-events.ts` (order matters: specific before generic).  
3. Add type to `detect-platform.ts` `PlatformType` + labels.  
4. Add SQL enum/check value if DB constrains `platform_type`.  
5. Document in `docs/ADAPTERS.md`.  
6. Prefer network JSON/ICS over screenshot/AI.  

## Hard rules when migrating

| Rule | Why |
|------|-----|
| Do not overwrite `events.source = 'manual'` | Curators win |
| Stamp `site_id` on every write | Multi-tenant isolation |
| Prefer draft/review before publish | Bad scrapes don't hit public |
| Keep adapter pure | Easier unit test / reuse |
| Log source URL + platform | Debug empty runs |

## Suggested ThinAIR rebuild layout

```
ThinAirSolutionsBuild/
  packages/ingestion-adapters/   ← copy engine/src/lib/sources + normalize
  apps/ingestion-worker/         ← optional CF worker
  apps/api/                      ← your API writes PartnerEvent → DB
  docs/ingestion/                ← this docs/ folder
```

## Validation checklist (agent)

- [ ] `npm install` + `npm run typecheck` in `engine/`  
- [ ] One venue with known ICS or TEC calendar returns ≥1 future event  
- [ ] Manual event not modified by re-scrape  
- [ ] New adapter listed in ADAPTERS.md  
- [ ] No secrets committed  

## License reminder

ThinAIR owns this package under `LICENSE` §2. Do not re-license as MIT without ThinAIR written approval.
