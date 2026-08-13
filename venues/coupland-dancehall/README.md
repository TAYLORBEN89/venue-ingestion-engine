# Coupland Dancehall

| | |
|--|--|
| Slug | `coupland-dancehall` |
| Platform | `etix` |
| Calendar | https://www.couplanddancehall.com/shows |
| Website | https://www.couplanddancehall.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-batch-round3.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs coupland-dancehall
```

## Scripts

- `engine/scripts/pilot-batch-round3.mjs`
- `engine/scripts/fix-coupland-images.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
