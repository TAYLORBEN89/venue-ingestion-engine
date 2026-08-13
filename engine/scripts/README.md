# Venue pilot / scrape scripts

Copied from the HeyAustin `apps/ingestion/scripts` tree. These are the **per-venue ingestion and scrape scripts** for the pilot — not a database dump.

Venue folders: [`../../venues/`](../../venues/)  
Index: [`../../docs/VENUES.md`](../../docs/VENUES.md)  
Reseed map: [`../../venues/catalog.json`](../../venues/catalog.json)  
Adapters the scripts call: [`src/lib/sources/`](../src/lib/sources/)

## Run

From **`engine/`** (cwd matters — many scripts read `./.dev.vars`):

```bash
cd engine
# needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .dev.vars
node scripts/pilot-docs-bar.mjs --probe-only
node scripts/pilot-docs-bar.mjs --ingest
node scripts/ingest-venue.mjs the-mohawk
```

Typical flags on dedicated pilots: `--probe-only`, `--ingest`, sometimes `--local-smoke`.

## Layout

| Pattern | Role |
|---------|------|
| `pilot-<venue>.mjs` | Wire one venue source + probe/ingest |
| `pilot-batch-*.mjs` / `repilot-venues.mjs` | Several venues in one run |
| `ingest-venue.mjs` / `ingest-all.mjs` | Trigger the Worker for a slug / all sources |
| `smoke-*.mjs` | Local adapter smoke (no worker required for some) |
| `probe-*.mjs` | Calendar/HTML research for a venue |
| `fix-*.mjs` / `curate-*.mjs` | Post-ingest image/title/queue fixes |
| `lib/` | Shared filters + San Jac ICS helper |

Skip anything named `tmp-*` if you add research dumps — do not commit those.

## Dependency on a store

Scripts look up venues **by slug**. If the Supabase project is gone, insert `sites` + `venues` + `venue_event_sources` from `catalog.json` first (see `docs/PORTING.md`), then re-run the matching pilot.

The scrape **logic** does not live only in these scripts. Structured calendars go through `src/lib/sources/*.ts`. The scripts record **which URL and platform_type each venue used**.
