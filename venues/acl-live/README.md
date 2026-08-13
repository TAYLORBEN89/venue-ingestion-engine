# ACL Live at the Moody Theater

| | |
|--|--|
| Slug | `acl-live` |
| Platform | `axs` |
| Calendar | https://www.acllive.com/events |
| Website | https://www.acllive.com/ |

## Run

From `engine/` (needs `.dev.vars` and a `venues` row with this slug):

```bash
cd engine
node scripts/pilot-acl-events-full.mjs --probe-only
```

Generic ingest after the source is wired:

```bash
node scripts/ingest-venue.mjs acl-live
```

## Scripts

- `engine/scripts/pilot-acl-events-full.mjs`
- `engine/scripts/pilot-acl-3ten-full-calendar.mjs`
- `engine/scripts/backfill-acl-ticket-urls.mjs`

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
