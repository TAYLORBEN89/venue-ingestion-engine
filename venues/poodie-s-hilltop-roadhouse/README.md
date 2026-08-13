# Poodie's Hilltop Roadhouse

| | |
|--|--|
| Slug | `poodie-s-hilltop-roadhouse` |
| Platform | `outhousetickets` |
| Calendar | https://outhousetickets.com/venues/poodies-hilltop-roadhouse |
| Website | https://poodies.net/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-poodies.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs poodie-s-hilltop-roadhouse
```

## Standalone scrape packet (this folder)

Poodie's is the only venue with a local calendar scrape (music.html + glance PNGs), not only the Outhouse worker path.

| File | Role |
|------|------|
| `rules.json` | Schedule / billing / category policy |
| `scrape-poodies-calendar.mjs` | Fetch pages + PNGs, parse music.html, merge slots |
| `august-2026-slots.json` | Human/vision slots from August glance PNG |
| `slots-merged.json` | Generated merge (music + fixture) |
| `poodies-check-artists.mjs` | Catalog match dry-run |
| `poodies-build-drafts.mjs` | Create **draft** events from slots |
| `poodies-stage-queue.mjs` | Stage ingested_events from slots |

```bash
# from repo root
node venues/poodie-s-hilltop-roadhouse/scrape-poodies-calendar.mjs
node venues/poodie-s-hilltop-roadhouse/poodies-check-artists.mjs --from=2026-07-26
node venues/poodie-s-hilltop-roadhouse/poodies-build-drafts.mjs --from=2026-07-26 --to=2026-08-08 --dry-run
```

Rules: one event per timed set; end time = gap to next set, max 2 hours; draft only.

## Scripts

- `engine/scripts/pilot-poodies.mjs`
- `venues/poodie-s-hilltop-roadhouse/scrape-poodies-calendar.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
