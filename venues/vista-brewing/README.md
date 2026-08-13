# Vista Brewing

| | |
|--|--|
| Slug | `vista-brewing` |
| Platform | `squarespace_events` |
| Calendar | https://www.vistabrewingtx.com/calendars |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-vista.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs vista-brewing
```

## Scripts

- `engine/scripts/pilot-vista.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
