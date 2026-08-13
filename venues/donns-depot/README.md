# Donn's Depot

| | |
|--|--|
| Slug | `donns-depot` |
| Platform | `schema_events` |
| Calendar | https://www.donnsdepot.com/ |
| Website | https://www.donnsdepot.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-batch-round4.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs donns-depot
```

## Scripts

- `engine/scripts/pilot-batch-round4.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
