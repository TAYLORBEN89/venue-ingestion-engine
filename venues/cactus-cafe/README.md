# Cactus Cafe

| | |
|--|--|
| Slug | `cactus-cafe` |
| Platform | `drupal_events` |
| Calendar | https://cactuscafe.org/events |
| Website | https://cactuscafe.org/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-batch-round3.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs cactus-cafe
```

## Scripts

- `engine/scripts/pilot-batch-round3.mjs`
- `engine/scripts/fix-cactus-full.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
