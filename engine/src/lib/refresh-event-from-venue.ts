/**
 * On re-fetch of a known show: update venue-controlled fields only.
 * POLICY: events with source = "manual" (built/edited in admin Event form) are never
 * touched — full curator ownership. Never overwrite fields marked field_sources manual.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSources } from "./enrich-from-artist";
import type { MatchedPartnerEvent } from "./dedup";

type FieldSource = FieldSources[keyof FieldSources];

function isLocked(source: FieldSource | undefined): boolean {
	// Manual edits are never clobbered. Artist-sourced fields stay unless still "artist".
	return source === "manual";
}

/**
 * Apply venue logistics from a re-fetched partner event onto a published events row.
 * Title is only updated when current field_sources.title is venue (or missing).
 * Manual events (source=manual): no-op — curated top-to-bottom wins.
 */
export async function refreshPublishedEventFromVenue(
	supabase: SupabaseClient,
	eventId: string,
	incoming: MatchedPartnerEvent,
): Promise<{ updated: boolean; reason?: string }> {
	const { data: existing, error } = await supabase
		.from("events")
		.select(
			"id, title, starts_at, ends_at, ticket_url, price_text, description, field_sources, status, source, event_series_id",
		)
		.eq("id", eventId)
		.maybeSingle();

	if (error || !existing) {
		return { updated: false, reason: error?.message ?? "not found" };
	}
	if (existing.status === "archived") {
		return { updated: false, reason: "archived" };
	}
	// Manual / admin-curated events trump all automation
	if (String(existing.source || "") === "manual") {
		return { updated: false, reason: "manual_event_locked" };
	}
	// Series-owned occurrences (parent recurring programs) never get scrape overwrites
	if ((existing as { event_series_id?: string | null }).event_series_id) {
		return { updated: false, reason: "series_event_locked" };
	}

	const sources = ((existing.field_sources ?? {}) as FieldSources) || {};
	const updates: Record<string, unknown> = {
		updated_at: new Date().toISOString(),
	};
	const nextSources: FieldSources = { ...sources };

	// Title: keep manual; otherwise keep venue title from re-fetch (never artist rename)
	if (!isLocked(sources.title)) {
		if (incoming.title && incoming.title !== existing.title) {
			updates.title = incoming.title;
			nextSources.title = "venue";
		}
	}

	if (!isLocked(sources.starts_at) && incoming.starts_at) {
		updates.starts_at = incoming.starts_at;
		nextSources.starts_at = "venue";
	}
	if (!isLocked(sources.ends_at)) {
		updates.ends_at = incoming.ends_at ?? null;
		nextSources.ends_at = incoming.ends_at ? "venue" : sources.ends_at ?? "none";
	}
	if (!isLocked(sources.ticket_url) && incoming.ticket_url) {
		updates.ticket_url = incoming.ticket_url;
		nextSources.ticket_url = "venue";
	}
	if (!isLocked(sources.price_text) && incoming.price_text != null) {
		updates.price_text = incoming.price_text;
		nextSources.price_text = incoming.price_text ? "venue" : "none";
	}
	// Description: only if currently venue-sourced (or empty), never manual/artist
	if (
		!isLocked(sources.description) &&
		(sources.description === "venue" || sources.description === "none" || !sources.description) &&
		incoming.description
	) {
		updates.description = incoming.description;
		nextSources.description = "venue";
	}

	// Artist-linked fields: refresh only when policy is still "artist"
	if (sources.youtube === "artist" && (incoming.youtube_id || incoming.youtube_embed)) {
		updates.youtube_id = incoming.youtube_id ?? null;
		updates.youtube_embed = incoming.youtube_embed ?? null;
		nextSources.youtube = "artist";
	}
	if (sources.seo_title === "artist" && incoming.seo_title) {
		updates.seo_title = incoming.seo_title;
		nextSources.seo_title = "artist";
	}
	if (sources.seo_description === "artist" && incoming.seo_description) {
		updates.seo_description = incoming.seo_description;
		nextSources.seo_description = "artist";
	}
	if (sources.focus_keyphrase === "artist" && incoming.focus_keyphrase) {
		updates.focus_keyphrase = incoming.focus_keyphrase;
		nextSources.focus_keyphrase = "artist";
	}
	if (sources.genres === "artist" && incoming.genres?.length) {
		updates.genres = incoming.genres;
		nextSources.genres = "artist";
	}

	updates.field_sources = nextSources;

	// Only write if something besides updated_at/field_sources changed
	const meaningful = Object.keys(updates).filter((k) => k !== "updated_at" && k !== "field_sources");
	if (meaningful.length === 0) {
		return { updated: false, reason: "no venue field changes" };
	}

	const { error: upErr } = await supabase.from("events").update(updates).eq("id", eventId);
	if (upErr) return { updated: false, reason: upErr.message };
	return { updated: true };
}
