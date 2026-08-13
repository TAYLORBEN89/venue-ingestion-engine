# Speakeasy

| | |
|--|--|
| Slug | `speakeasy` |
| Platform | `eventon` |
| Calendar | https://speakeasyaustin.com/calendar/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-speakeasy.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs speakeasy
```

## Scripts

- `engine/scripts/pilot-speakeasy.mjs`
- `engine/scripts/smoke-eventon-speakeasy.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
