# Vulcan Gas Company

| | |
|--|--|
| Slug | `vulcan-gas-company` |
| Platform | `webflow` |
| Calendar | https://www.vulcanatx.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-vulcan.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs vulcan-gas-company
```

## Scripts

- `engine/scripts/pilot-vulcan.mjs`
- `engine/scripts/pilot-vulcan-stage.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
