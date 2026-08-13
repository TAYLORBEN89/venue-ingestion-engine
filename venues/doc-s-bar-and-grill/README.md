# Doc's Bar and Grill

| | |
|--|--|
| Slug | `doc-s-bar-and-grill` |
| Platform | `spotapps` |
| Calendar | https://eatdrinkdocs.com/events |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-docs-bar.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs doc-s-bar-and-grill
```

## Scripts

- `engine/scripts/pilot-docs-bar.mjs`
- `engine/scripts/smoke-spotapps-docs.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
