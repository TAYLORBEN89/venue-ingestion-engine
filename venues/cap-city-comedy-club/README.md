# Cap City Comedy Club

| | |
|--|--|
| Slug | `cap-city-comedy-club` |
| Platform | `seatengine` |
| Calendar | https://www.capcitycomedy.com/calendar |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-cap-city.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs cap-city-comedy-club
```

## Scripts

- `engine/scripts/pilot-cap-city.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
