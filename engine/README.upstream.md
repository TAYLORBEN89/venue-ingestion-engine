# apps/ingestion — scrape & enrich worker

Cloudflare Worker with **Browser Run**, **Workers AI**, and **Workflows** for partner calendar ingestion.

## Commands

```bash
npm install
npm run typecheck
npm run dev      # wrangler dev
npm run deploy
```

Secrets: `.dev.vars` from `.dev.vars.example` (local) / Cloudflare secrets (prod).

## Feature flags (`wrangler.jsonc` vars)

| Flag | Meaning |
|------|---------|
| `ENABLE_AI_SCRAPE_FALLBACK` | Workers AI extraction path when needed |
| `ENABLE_AUTO_ARTIST_GENERATION` | Auto-create artist pages for unmatched bands (often **false**) |

## Layout

| Path | Role |
|------|------|
| `src/index.ts` | HTTP entry (triggers, generate-artist, …) |
| `src/workflows/` | Venue ingestion + scheduler |
| `src/lib/sources/` | Platform adapters (TEC, Webflow, SeatEngine, Squarespace, …) |
| `src/lib/extract.ts` | Workers AI structured extract (Llama on CF) |
| `src/lib/browser.ts` | Browser Run helpers |
| `scripts/` | Ops / pilots — prefer named scripts; ignore `tmp-*` |

## AI note

Extraction uses **Cloudflare Workers AI**, not Google AI Studio.

## Agent context

Root [`AGENTS.md`](../../AGENTS.md), [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md), [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md).
