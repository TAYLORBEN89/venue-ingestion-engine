# The Mohawk

| | |
|--|--|
| Slug | `the-mohawk` |
| Platform | `prekindle` |
| Calendar | https://mohawkaustin.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-mohawk.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs the-mohawk
```

## Scripts

- `engine/scripts/pilot-mohawk.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
