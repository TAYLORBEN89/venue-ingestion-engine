# The Historic Scoot Inn

| | |
|--|--|
| Slug | `the-historic-scoot-inn` |
| Platform | `livenation` |
| Calendar | https://scootinnaustin.com/events |
| Website | https://scootinnaustin.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/repilot-venues.mjs
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs the-historic-scoot-inn
```

## Scripts

- `engine/scripts/repilot-venues.mjs`
- `engine/scripts/fix-scoot-descriptions.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
