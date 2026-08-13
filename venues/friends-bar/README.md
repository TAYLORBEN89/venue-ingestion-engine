# Friends Bar

| | |
|--|--|
| Slug | `friends-bar` |
| Platform | `wix_events` |
| Calendar | https://www.friendsbar.com/calendar |
| Website | https://www.friendsbar.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-batch-new.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs friends-bar
```

## Scripts

- `engine/scripts/pilot-batch-new.mjs`
- `engine/scripts/fix-friends-full.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
