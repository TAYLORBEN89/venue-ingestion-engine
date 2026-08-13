# Germania Insurance Amphitheater

| | |
|--|--|
| Slug | `germania-insurance-amphitheater` |
| Platform | `custom_html` |
| Calendar | http://germaniaamp.com/events/ |
| Website | https://www.germaniaamp.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-germania-amp.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs germania-insurance-amphitheater
```

## Scripts

- `engine/scripts/pilot-germania-amp.mjs`
- `engine/scripts/smoke-germania-amp.mjs`
- `engine/scripts/fix-germania-images.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
