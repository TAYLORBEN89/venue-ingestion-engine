# The Velveeta Room

| | |
|--|--|
| Slug | `the-velveeta-room` |
| Platform | `seatengine` |
| Calendar | https://the-velveeta-room-the-velveeta-room.seatengine.com/calendar |
| Website | https://www.thevelveetaroom.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-velveeta-room.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs the-velveeta-room
```

## Scripts

- `engine/scripts/pilot-velveeta-room.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
