# Frontyard Brewing

| | |
|--|--|
| Slug | `frontyard-brewing` |
| Platform | `squarespace_events` |
| Calendar | https://www.frontyardbrewing.com/upcoming-events |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-frontyard.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs frontyard-brewing
```

## Scripts

- `engine/scripts/pilot-frontyard.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
