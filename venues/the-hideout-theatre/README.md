# The Hideout Theatre

| | |
|--|--|
| Slug | `the-hideout-theatre` |
| Platform | `events_manager` |
| Calendar | https://hideouttheatre.com/calendar/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-hideout.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs the-hideout-theatre
```

## Scripts

- `engine/scripts/pilot-hideout.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
