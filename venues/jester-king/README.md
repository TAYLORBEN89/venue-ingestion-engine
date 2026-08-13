# Jester King

| | |
|--|--|
| Slug | `jester-king` |
| Platform | `spacecrafted` |
| Calendar | https://jesterkingbrewery.com/events-calendar |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-jester-king.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs jester-king
```

## Scripts

- `engine/scripts/pilot-jester-king.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
