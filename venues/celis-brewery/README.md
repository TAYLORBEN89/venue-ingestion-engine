# Celis Brewery

| | |
|--|--|
| Slug | `celis-brewery` |
| Platform | `wix_events` |
| Calendar | https://celisbeers.com/events |
| Website | https://celisbeers.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-batch-round3.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs celis-brewery
```

## Scripts

- `engine/scripts/pilot-batch-round3.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
