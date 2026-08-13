import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createServiceRoleClient } from "../lib/supabase";
import type { VenueIngestionParams } from "../types";

const WAVE_SIZE = 2;
const WAVE_DELAY = "60 seconds";

function chunk<T>(items: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}

interface ScheduledVenue {
	venueId: string;
	sourceId?: string;
}

/**
 * Weekly fan-out (cron Mon 09:00 UTC): one VenueIngestionWorkflow per enabled
 * venue_event_sources row. Manual /ingest still works anytime.
 * Falls back to legacy venues with calendar_url when no sources table rows exist.
 */
export class IngestionSchedulerWorkflow extends WorkflowEntrypoint<CloudflareEnv> {
	async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
		const supabase = createServiceRoleClient(this.env);

		const targets = await step.do("find venues due for ingestion", async () => {
			const scheduled: ScheduledVenue[] = [];

			const { data: sources, error: sourcesError } = await supabase
				.from("venue_event_sources")
				.select("id, venue_id, venues!inner(status)")
				.eq("is_enabled", true)
				.eq("venues.status", "published");

			if (sourcesError) {
				throw new Error(`Failed to list venue_event_sources: ${sourcesError.message}`);
			}

			for (const row of sources ?? []) {
				scheduled.push({ venueId: (row as { venue_id: string }).venue_id, sourceId: (row as { id: string }).id });
			}

			if (scheduled.length === 0) {
				const { data: legacy, error: legacyError } = await supabase
					.from("venues")
					.select("id")
					.or("calendar_url.not.is.null,event_feed_url.not.is.null")
					.eq("status", "published");
				if (legacyError) throw new Error(`Failed to list legacy venues: ${legacyError.message}`);
				for (const row of legacy ?? []) {
					scheduled.push({ venueId: (row as { id: string }).id });
				}
			}

			return scheduled;
		});

		const runTimestamp = Date.now();
		let scheduled = 0;
		const waves = chunk(targets, WAVE_SIZE);
		for (const [waveIndex, wave] of waves.entries()) {
			await step.do(`trigger venue ingestion wave ${waveIndex} (${scheduled}-${scheduled + wave.length})`, async () => {
				await this.env.VENUE_INGESTION_WORKFLOW.createBatch(
					wave.map((target): { id: string; params: VenueIngestionParams } => ({
						id: `${target.venueId}-${target.sourceId ?? "legacy"}-${runTimestamp}`,
						params: { venueId: target.venueId, sourceId: target.sourceId },
					})),
				);
			});
			scheduled += wave.length;

			if (waveIndex < waves.length - 1) {
				await step.sleep(`wait between wave ${waveIndex} and ${waveIndex + 1}`, WAVE_DELAY);
			}
		}

		return { venuesScheduled: scheduled };
	}
}