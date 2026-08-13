# The White Horse

| | |
|--|--|
| Slug | `the-white-horse` |
| Platform | `wix_events` |
| Calendar | https://thewhitehorseaustin.com/events |
| Website | https://thewhitehorseaustin.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-batch-round2.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs the-white-horse
```

## Scripts

- `engine/scripts/pilot-batch-round2.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
