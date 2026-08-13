# Schema (ingestion-related subset)

Copied from the HeyAustin pilot monorepo. Apply in numeric order on a fresh Postgres/Supabase project **or** map these concepts into ThinAIR’s existing schema.

## Included files

| File | Why |
|------|-----|
| `001_initial_schema.sql` | Core sites, venues, events, … |
| `002_ingestion_raw_payload.sql` | Ingestion payload storage |
| `005_partner_event_import.sql` | Partner import fields |
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
