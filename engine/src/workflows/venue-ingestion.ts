import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createServiceRoleClient } from "../lib/supabase";
import { matchPartnerEvents } from "../lib/dedup";
import { applyEventMetadata } from "../lib/apply-event-metadata";
import { enrichFromArtistCatalog } from "../lib/enrich-from-artist";
import { loadClassificationContext } from "../lib/load-classification-context";
import { loadVenueSource } from "../lib/load-venue-source";
import { ensureArtistsForUnmatchedEvents } from "../lib/ensure-artist-catalog";
import { extractBandName } from "../lib/parse-band-name";
import {
	hydrateArtistMatch,
	loadArtistCatalog,
	loadCatalogArtistsByIds,
	matchBandToCatalog,
	matchLineupToCatalog,
} from "../lib/match-artist";
import { fetchPartnerEvents } from "../lib/sources/fetch-partner-events";
import { parseSeatEngineEventIdFromSource } from "../lib/sources/seatengine";
import type { PartnerEvent } from "../lib/normalize";
import type { VenueIngestionParams } from "../types";

interface VenueWithSite {
	id: string;
	site_id: string;
	slug: string;
	name: string;
	address: string | null;
	description: string | null;
	website_url: string | null;
	sites: { timezone: string; city: string; name: string } | null;
}

function isValid(event: PartnerEvent, scrapeDaysAhead: number): boolean {
	if (!event.title.trim()) return false;
	const startsAt = new Date(event.starts_at);
	if (Number.isNaN(startsAt.getTime())) return false;

	const horizon = Date.now() + scrapeDaysAhead * 24 * 60 * 60 * 1000;
	if (startsAt.getTime() > horizon) return false;

	const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
	if (startsAt.getTime() < oneDayAgo) {
		const endsAt = event.ends_at ? new Date(event.ends_at) : null;
		const stillRunning = endsAt !== null && !Number.isNaN(endsAt.getTime()) && endsAt.getTime() > Date.now();
		if (!stillRunning) return false;
	}
	return true;
}

export class VenueIngestionWorkflow extends WorkflowEntrypoint<CloudflareEnv, VenueIngestionParams> {
	async run(event: WorkflowEvent<VenueIngestionParams>, step: WorkflowStep) {
		const supabase = createServiceRoleClient(this.env);
		const { venueId, sourceId } = event.payload;

		const venue = await step.do("load venue", async () => {
			const { data, error } = await supabase
				.from("venues")
				.select("id, site_id, slug, name, address, description, website_url, sites(timezone, city, name)")
				.eq("id", venueId)
				.single<VenueWithSite>();

			if (error || !data) {
				throw new NonRetryableError(`Venue ${venueId} not found: ${error?.message ?? "no rows"}`);
			}
			return data;
		});

		const source = await step.do("load venue event source", async () =>
			loadVenueSource(supabase, venueId, sourceId),
		);

		const runId = await step.do("create ingestion run", async () => {
			const { data, error } = await supabase
				.from("ingestion_runs")
				.insert({ site_id: venue.site_id, venue_id: venue.id, status: "running" })
				.select("id")
				.single<{ id: string }>();
			if (error || !data) {
				throw new NonRetryableError(`Failed to create ingestion_runs row: ${error?.message}`);
			}
			return data.id;
		});

		try {
			const enableAiScrapeFallback = this.env.ENABLE_AI_SCRAPE_FALLBACK === "true";
			const timezone = source.timezone_override ?? venue.sites?.timezone ?? "America/Chicago";
			const calendarUrl = source.calendar_url ?? "";
			const isSeatEngineSource =
				/seatengine/i.test(source.platform_type ?? "") ||
				/capcitycomedy\.com|seatengine/i.test(calendarUrl);

			// Skip detail pages for listings already published OR staged (pending/approved).
			// Never early-stop the calendar: new shows can appear between known dates.
			// Chunked pilots work by maxShows + multi-run; each run skips already-staged ids.
			const knownPartnerEventIds = isSeatEngineSource
				? await step.do("load known seatengine event ids", async () => {
						const ids = new Set<string>();
						const add = (raw: string | null | undefined) => {
							const id = parseSeatEngineEventIdFromSource(raw);
							if (id) ids.add(id);
						};
						const { data: published } = await supabase
							.from("events")
							.select("source_event_id, source_url, ticket_url")
							.eq("venue_id", venueId)
							.is("deleted_at", null)
							.limit(2000);
						for (const row of published ?? []) {
							add(row.source_event_id as string | null);
							add(row.source_url as string | null);
							add(row.ticket_url as string | null);
						}
						const { data: staged } = await supabase
							.from("ingested_events")
							.select("source_event_id, source_url, raw_payload")
							.eq("venue_id", venueId)
							.in("review_status", ["pending", "approved"])
							.limit(3000);
						for (const row of staged ?? []) {
							const payload = (row.raw_payload ?? {}) as Record<string, unknown>;
							add(row.source_event_id as string | null);
							add(row.source_url as string | null);
							if (typeof payload.source_url === "string") add(payload.source_url);
							if (typeof payload.ticket_url === "string") add(payload.ticket_url);
						}
						return [...ids];
					})
				: [];

			// Small batches (see maxShows) finish inside CF workflow limits; multi-run fills the rest
			const fetchTimeout = isSeatEngineSource ? "10 minutes" : "5 minutes";

			const fetched = await step.do(
				"fetch partner events v3",
				{
					retries: { limit: 2, delay: "20 seconds", backoff: "exponential" },
					timeout: fetchTimeout,
				},
				async () =>
					fetchPartnerEvents({
						browser: this.env.BROWSER,
						ai: this.env.AI,
						enableAiScrapeFallback,
						timezone,
						scrapeDaysAhead: source.scrape_days_ahead,
						ticketmasterApiKey: this.env.TICKETMASTER_API_KEY ?? null,
						knownPartnerEventIds,
						// Never force full re-scrape of known listings in normal/pilot runs
						forceFullSeatEngineScan: false,
						venue: {
							name: venue.name,
							address: venue.address,
							website_url: venue.website_url,
							calendar_url: source.calendar_url,
							event_feed_url: source.event_feed_url,
							event_feed_type: source.event_feed_type,
							platform_type: source.platform_type,
						},
					}),
			);

			const validated = fetched.events.filter((e) => isValid(e, source.scrape_days_ahead));

			const siteCity = venue.sites?.city ?? null;
			const siteBrand = venue.sites?.name ?? "HeyAustin";
			const autoArtistGeneration = this.env.ENABLE_AUTO_ARTIST_GENERATION !== "false";

			// NOTE: Artist catalog must be loaded *inside* the steps that use it.
			// Never return the full catalog from step.do — CF Workflows enforce a 1 MiB
			// step-output limit ("Step load artist catalog-1 output is too large").

			if (autoArtistGeneration) {
				await step.do("ensure unmatched artists", async () => {
					const catalog = await loadArtistCatalog(supabase, venue.site_id);
					return ensureArtistsForUnmatchedEvents({
						supabase,
						browser: this.env.BROWSER,
						ai: this.env.AI,
						siteId: venue.site_id,
						city: siteCity,
						events: validated,
						isUnmatched: (event) => {
							const match = matchBandToCatalog(event.title, catalog, venue.name);
							return match.artist_match_status === "unmatched";
						},
						getBandName: (title) => extractBandName(title, venue.name),
					});
				});
			}

			const classificationCtx = await step.do("load classification context", async () =>
				loadClassificationContext(supabase, venue.site_id, venue.id, source.sourceId),
			);

			const seriesCatalog = await step.do("load event series catalog", async () => {
				const { loadPublishedSeriesCatalog } = await import("../lib/match-event-series");
				return loadPublishedSeriesCatalog(supabase, venue.site_id);
			});

			const enriched = await step.do("match band catalog", async () => {
				const { matchEventSeries } = await import("../lib/match-event-series");
				// Slim match index (names/aliases only) — safe size; hydrate matched rows next.
				const catalog = await loadArtistCatalog(supabase, venue.site_id);
				const prelim = validated.map((partnerEvent) => {
					const { primary, lineup } = matchLineupToCatalog(
						partnerEvent.title,
						catalog,
						venue.name,
					);
					return { partnerEvent, primary, lineup };
				});
				const ids: string[] = [];
				for (const p of prelim) {
					if (p.primary.matched_artist_id) ids.push(p.primary.matched_artist_id);
					for (const slot of p.lineup) {
						if (slot.artist_id) ids.push(slot.artist_id);
					}
				}
				const fullById = await loadCatalogArtistsByIds(supabase, ids);

				return prelim.map(({ partnerEvent, primary, lineup }) => {
					const hydratedPrimary = hydrateArtistMatch(primary, fullById);
					const hydratedLineup = lineup.map((slot) => {
						if (!slot.artist_id) return slot;
						const full = fullById.get(slot.artist_id);
						return full
							? { ...slot, artist_name: full.name }
							: slot;
					});
					const fromArtist = enrichFromArtistCatalog(
						partnerEvent,
						hydratedPrimary,
						siteCity,
						venue.description,
						hydratedLineup,
						siteBrand,
						classificationCtx.venueCategorySlugs,
						venue.slug,
					);
					const withMeta = applyEventMetadata(fromArtist, classificationCtx);
					const seriesHit = matchEventSeries(partnerEvent.title, seriesCatalog, {
						venueId: venue.id,
					});
					return {
						...withMeta,
						matched_series_id: seriesHit?.id ?? null,
						matched_series_name: seriesHit?.name ?? null,
					};
				});
			});

			// Duplicate check worker: within-batch + published events + pending queue
			const matched = await step.do("dedup / duplicate check", async () =>
				matchPartnerEvents(supabase, venue.id, enriched),
			);

			// Re-fetch: update venue-owned fields on existing published events without clobbering manual locks
			await step.do("refresh existing published events", async () => {
				const { refreshPublishedEventFromVenue } = await import("../lib/refresh-event-from-venue");
				const refreshes = matched.filter(
					(m) => m.is_duplicate && m.match_status === "matched_existing" && m.matched_event_id,
				);
				for (const m of refreshes) {
					if (!m.matched_event_id) continue;
					await refreshPublishedEventFromVenue(supabase, m.matched_event_id, m);
				}
				return refreshes.length;
			});

			const toStage = matched.filter((m) => !m.is_duplicate && m.match_status !== "matched_existing");

			const stagedIds = await step.do("stage ingested events", async () => {
				if (toStage.length === 0) return [] as string[];
				// POLICY: AI / partner ingestion is NEVER auto-approved.
				// Every row stages as pending for human review in admin /ingestion.
				// publish_mode=auto_publish is intentionally ignored (do not re-enable).
				const rows = toStage.map((m) => ({
					ingestion_run_id: runId,
					venue_id: venue.id,
					raw_title: m.title,
					raw_date_text: m.raw_date_text,
					parsed_starts_at: m.starts_at,
					parsed_ends_at: m.ends_at,
					source_url: m.source_url,
					source_event_id: m.source_event_id,
					fingerprint: m.fingerprint,
					source_partner: m.source_partner,
					extracted_band_name: m.extracted_band_name,
					matched_artist_id: m.matched_artist_id,
					artist_match_status: m.artist_match_status,
					// Non-artist series stub (Gospel Brunch, Sing Along, …)
					matched_series_id:
						(m as { matched_series_id?: string | null }).matched_series_id ?? null,
					match_status: m.match_status,
					matched_event_id: m.matched_event_id,
					review_status: "pending" as const,
					reviewed_at: null,
					raw_payload: {
						description: m.description,
						price_text: m.price_text,
						ticket_url: m.ticket_url,
						image_url: m.image_url,
						confidence: m.confidence,
						address: m.address,
						import_method: fetched.method,
						publish_mode: "draft",
						artist_match_score: m.artist_match_score,
						artist_match_confidence: m.artist_match_confidence,
						original_title: m.original_title ?? m.title,
						fetched_event_title: m.original_title ?? m.title,
						fetched_artist_text: m.extracted_band_name,
						artist_content_source: m.artist_content_source,
						field_sources: m.field_sources,
						matched_lineup: m.matched_lineup ?? [],
						matched_series_name:
							(m as { matched_series_name?: string | null }).matched_series_name ?? null,
						artist_media_id: m.artist_media_id,
						youtube_embed: m.youtube_embed,
						youtube_id: m.youtube_id,
						genres: m.genres,
						category_id: m.category_id,
						category_slug: m.category_slug,
						schema_type: m.schema_type,
						seo_title: m.seo_title,
						seo_description: m.seo_description,
						focus_keyphrase: m.focus_keyphrase,
						event_intro: m.event_intro,
					},
				}));

				const { data: inserted, error } = await supabase
					.from("ingested_events")
					.insert(rows)
					.select("id, raw_title, parsed_starts_at, parsed_ends_at, source_url, source_event_id, fingerprint, matched_artist_id, matched_event_id, raw_payload");
				if (error) {
					throw new Error(`Failed to insert ingested_events: ${error.message}`);
				}
				return (inserted ?? []).map((r) => r.id as string);
			});

			// POLICY: AI / partner ingestion is NEVER auto-published.
			// Step name kept so Cloudflare Workflow history stays stable; body is a hard no-op.
			const autoPublished = await step.do("auto-publish staged events", async () => {
				return 0;
			});

			await step.do("mark ingestion run successful", async () => {
				await supabase
					.from("ingestion_runs")
					.update({ status: "success", finished_at: new Date().toISOString() })
					.eq("id", runId);

				if (source.sourceId) {
					const latestStart = validated
						.map((e) => e.starts_at)
						.sort()
						.at(-1);
					await supabase
						.from("venue_event_sources")
						.update({
							last_scrape_at: new Date().toISOString(),
							last_scrape_status: "success",
							last_scrape_error: null,
							last_event_imported_at: latestStart ?? null,
							updated_at: new Date().toISOString(),
						})
						.eq("id", source.sourceId);
				}
			});

			const duplicatesSkipped = matched.filter((m) => m.is_duplicate).length;
			return {
				venueId: venue.id,
				sourceId: source.sourceId,
				method: fetched.method,
				eventsFound: fetched.events.length,
				eventsStaged: toStage.length,
				eventsAutoPublished: autoPublished,
				duplicatesSkipped,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await step.do("mark ingestion run failed", async () => {
				await supabase
					.from("ingestion_runs")
					.update({ status: "error", error_message: message, finished_at: new Date().toISOString() })
					.eq("id", runId);

				if (source.sourceId) {
					await supabase
						.from("venue_event_sources")
						.update({
							last_scrape_at: new Date().toISOString(),
							last_scrape_status: "error",
							last_scrape_error: message,
							updated_at: new Date().toISOString(),
						})
						.eq("id", source.sourceId);
				}
			});
			throw err;
		}
	}
}