# The Carousel Lounge

| | |
|--|--|
| Slug | `the-carousel-lounge` |
| Platform | `tec` |
| Calendar | https://carousellounge.com/elementor-1022/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-carousel-lounge.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs the-carousel-lounge
```

## Scripts

- `engine/scripts/pilot-carousel-lounge.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
