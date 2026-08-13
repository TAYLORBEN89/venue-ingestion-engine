# Poodie's Hilltop Roadhouse — calendar pilot

**Venue:** Poodie's Hilltop Roadhouse (`poodie-s-hilltop-roadhouse`)  
**Site:** HeyAustin  
**Partner:** https://poodies.net/

## Sources (in priority order)

1. **https://poodies.net/music.html** — day-by-day set list with times (best when current).
2. **https://poodies.net/calendar.html** → month glance PNG  
   e.g. `/images/events/calendar/july.png`
3. **https://poodies.net/calendar-next.html** → next month PNG  
   e.g. `/images/events/calendar/august.png`
4. **Outhouse** (optional later) — ticket URLs only, not full calendar.

## Packet files

| File | Role |
|------|------|
| `rules.json` | Schedule / billing / category policy |
| `scrape-poodies-calendar.mjs` | Fetch pages + PNGs, parse music.html, merge slots |
| `august-2026-slots.json` | Human/vision slots from August glance PNG |
| `slots-merged.json` | Generated merge (music + fixture) |
| `poodies-check-artists.mjs` | Catalog match dry-run |
| `poodies-build-drafts.mjs` | Create **draft** events from slots |
| `README.md` | This doc |

## Workflow

From **repo root** (or `apps/ingestion` with adjusted paths):

```powershell
# 1) Scrape partner pages + merge slots
node apps/ingestion/venues/poodies-hilltop/scrape-poodies-calendar.mjs

# 2) Artist coverage
node apps/ingestion/venues/poodies-hilltop/poodies-check-artists.mjs --from=2026-07-26

# 3) Dry-run drafts (a few days)
node apps/ingestion/venues/poodies-hilltop/poodies-build-drafts.mjs --from=2026-07-26 --to=2026-08-08 --dry-run

# 4) Write drafts when ready
node apps/ingestion/venues/poodies-hilltop/poodies-build-drafts.mjs --from=2026-07-26 --to=2026-08-08
```

Flags:

- `--include-optional` — open mics
- `--dry-run` — no DB writes

## Rules (summary)

- **One event per timed set** (not one card per night).
- **End time:** gap to next set same day, capped at **2 hours**.
- **Artists:** link only names already in catalog; still name misses in intro.
- **Madam Radar Duo** ≠ full **Madam Radar**.
- **Songwriters Showcase:** one event, host + guest; guest is face/hero.
- **Draft only** — no auto-publish.

## Related

- Outhouse adapter: `apps/ingestion/src/lib/sources/outhousetickets.ts` (ticketed slice)
- Older Ben probe/ingest: `apps/ingestion/scripts/pilot-poodies.mjs`
