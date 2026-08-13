# The Long Center

| | |
|--|--|
| Slug | `the-long-center` |
| Platform | `eventon` |
| Calendar | https://thelongcenter.org/upcoming-calendar/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-long-center-full.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs the-long-center
```

## Scripts

- `engine/scripts/pilot-long-center-full.mjs`
- `engine/scripts/pilot-batch-round4.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
