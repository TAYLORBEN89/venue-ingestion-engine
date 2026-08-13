# San Jac Saloon

| | |
|--|--|
| Slug | `san-jac-saloon` |
| Platform | `ical` |
| Calendar | https://www.sanjacsaloon.com/events |
| Website | https://www.sanjacsaloon.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-san-jac.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs san-jac-saloon
```

## Scripts

- `engine/scripts/pilot-san-jac.mjs`
- `engine/scripts/smoke-san-jac-ics.mjs`
- `engine/scripts/smoke-san-jac-htmlembed.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
