# Flamingo Cantina

| | |
|--|--|
| Slug | `flamingo-cantina` |
| Platform | `tec` |
| Calendar | https://flamingocantina.com/calendar/list/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-flamingo-cantina.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs flamingo-cantina
```

## Scripts

- `engine/scripts/pilot-flamingo-cantina.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
