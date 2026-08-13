# Moontower Saloon

| | |
|--|--|
| Slug | `moontower-saloon` |
| Platform | `spotapps` |
| Calendar | https://moontowersaloon.com/austin-menchaca-moontower-saloon-events |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-moontower.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs moontower-saloon
```

## Scripts

- `engine/scripts/pilot-moontower.mjs`
- `engine/scripts/fix-moontower-images.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
