# Environment & bindings

## Cloudflare Worker (`engine/wrangler.jsonc`)

| Binding | Purpose |
|---------|---------|
| `BROWSER` | Browser Run (headless Chrome) |
| `AI` | Workers AI |
| `VENUE_INGESTION_WORKFLOW` | Per-venue workflow |
| `SCHEDULER_WORKFLOW` | Scheduled fan-out |

### Vars

| Name | Meaning |
|------|---------|
| `ENABLE_AI_SCRAPE_FALLBACK` | `true`/`false` — AI extract when structured adapters fail |
| `ENABLE_AUTO_ARTIST_GENERATION` | Auto artist pages (often off in conservative deploys) |

### Secrets (set via `wrangler secret put` or `.dev.vars` local)

| Name | Required | Purpose |
|------|----------|---------|
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server writes (never expose to browser) |
| `TICKETMASTER_API_KEY` | no | Image/enrichment helpers |
| Other | no | As added in `cloudflare-env.d.ts` |

## Local `.dev.vars` example

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
ENABLE_AI_SCRAPE_FALLBACK=true
ENABLE_AUTO_ARTIST_GENERATION=false
```

Do not commit this file.

## HTTP entry (typical)

Worker `src/index.ts` exposes authenticated triggers to start workflows. Protect with shared secret or CF Access in production.

## Target platform without Cloudflare

You must reimplement:

1. Scheduled jobs (cron/queue)  
2. Headless browser (Playwright recommended)  
3. Optional LLM JSON extract (any provider)  
4. DB client with service credentials  

Adapters that only use `fetch` + HTML/JSON need no browser.
