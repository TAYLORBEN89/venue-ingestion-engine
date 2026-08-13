# Esther's Follies

| | |
|--|--|
| Slug | `esther-s-follies` |
| Platform | `esthers_follies` |
| Calendar | https://esthersfollies.com/tickets |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/repilot-venues.mjs
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs esther-s-follies
```

## Scripts

- `engine/scripts/repilot-venues.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
