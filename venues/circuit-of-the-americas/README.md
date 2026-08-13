# Circuit of The Americas

| | |
|--|--|
| Slug | `circuit-of-the-americas` |
| Platform | `custom_html` |
| Calendar | https://circuitoftheamericas.com/events/?layout=list |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-cota.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs circuit-of-the-americas
```

## Scripts

- `engine/scripts/pilot-cota.mjs`
- `engine/scripts/curate-cota.mjs`
- `engine/scripts/stage-cota-local.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
