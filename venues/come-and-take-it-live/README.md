# Come and Take It Live

| | |
|--|--|
| Slug | `come-and-take-it-live` |
| Platform | `rhp_events` |
| Calendar | https://comeandtakeitproductions.com/calendar/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-cati-live.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs come-and-take-it-live
```

## Scripts

- `engine/scripts/pilot-cati-live.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
