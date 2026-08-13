# Hole in the Wall

| | |
|--|--|
| Slug | `hole-in-the-wall` |
| Platform | `prekindle` |
| Calendar | https://www.theholeinthewallaustin.com/shows |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-hole-in-the-wall.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs hole-in-the-wall
```

## Scripts

- `engine/scripts/pilot-hole-in-the-wall.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
