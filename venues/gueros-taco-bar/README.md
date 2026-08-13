# Guero's Taco Bar

| | |
|--|--|
| Slug | `gueros-taco-bar` |
| Platform | `tec` |
| Calendar | https://www.guerostacobar.com/events/ |
| Website | https://www.guerostacobar.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-batch-round5.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs gueros-taco-bar
```

## Scripts

- `engine/scripts/pilot-batch-round5.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
