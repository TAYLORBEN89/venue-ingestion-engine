# Schema (ingestion-related subset)

Copied from the HeyAustin pilot monorepo. Apply in numeric order on a fresh Postgres/Supabase project **or** map these concepts into ThinAIR’s existing schema.

## Included files

| File | Why |
|------|-----|
| `001_initial_schema.sql` | Core sites, venues, events, … (`ingested_events.match_status`, `matched_event_id` already here) |
| `002_ingestion_raw_payload.sql` | Ingestion payload storage |
| `003_venue_event_seo_fields.sql` | `seo_title` / `seo_description` on events and venues |
| `004_seo_focus_keyphrase.sql` | `focus_keyphrase` on events and venues only (`sites.city` backfill omitted) |
| `005_partner_event_import.sql` | Partner import fields |
| `006_band_catalog.sql` | Artist aliases/SEO, ingested artist match columns, `idx_artists_site_name` |
| `007_artist_youtube_genres.sql` | YouTube + genres on artists and events, `idx_artists_youtube_id` |
| `019_artist_enrichment_fields.sql` | `events.field_sources`, `event_artists` billing order and role |
| `021_soft_delete_trash.sql` | `deleted_at` and partial indexes |
| `028_event_series.sql` | `event_series`, `events.event_series_id`, `ingested_events.matched_series_id` |
| `008_venue_event_sources.sql` | **Per-venue calendar sources** |
| `023+ platform_type` migrations | Expand allowed `platform_type` values |
| Brand-specific platform types | comedy_mothership, docs_drive_in, laketravis, … |

## Agent note

If ThinAIR already has venues/events tables, **do not blindly apply 001**. Instead:

1. Ensure columns exist for: `site_id`, venue calendar URL, platform type, partner event id, `source`, draft/publish status.  
2. Port only the `venue_event_sources` / `ingested_events` / `ingestion_runs` ideas.  
3. Keep adapter `platform_type` strings stable so `detect-platform.ts` stays valid.

## Full pilot schema

Complete ordered migrations live in the parent monorepo `events-platform/schema/` if you need admin, series, regions, etc.
