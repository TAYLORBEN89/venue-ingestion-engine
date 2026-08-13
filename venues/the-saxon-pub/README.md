# The Saxon Pub

| | |
|--|--|
| Slug | `the-saxon-pub` |
| Platform | `tec` |
| Calendar | https://thesaxonpub.com/events/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/saxon-full-calendar.mjs
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs the-saxon-pub
```

## Scripts

- `engine/scripts/saxon-full-calendar.mjs`
- `engine/scripts/repilot-venues.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
