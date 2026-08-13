import {
	categorySlugFromExperienceKind,
	classifyEventCategorySlug,
	inferEventGenres,
	resolveEventSchemaType,
	type EventCategorySlug,
} from "./classify-event-metadata";
import { inferVenueExperienceKind } from "./event-intro";
import type { ClassificationContext } from "./load-classification-context";
import type { EnrichedPartnerEvent } from "./enrich-from-artist";

export interface EventWithMetadata extends EnrichedPartnerEvent {
	category_id: string | null;
	category_slug: EventCategorySlug;
	/** schema.org type for approve / JSON-LD (kind-aware) */
	schema_type: string;
}

export function applyEventMetadata(
	event: EnrichedPartnerEvent,
	ctx: ClassificationContext,
): EventWithMetadata {
	const title = event.original_title || event.title;

	let categorySlug = classifyEventCategorySlug({
		title,
		description: event.description,
		venueCategorySlugs: ctx.venueCategorySlugs,
		defaultCategorySlug: ctx.defaultCategorySlug,
		venueSlug: (event as { venue_slug?: string | null }).venue_slug ?? null,
		venueName: event.venue_name ?? null,
	});

	const kind = inferVenueExperienceKind({
		venueName: event.venue_name,
		eventTitle: title,
		genres: event.genres,
		venueCategorySlugs: ctx.venueCategorySlugs,
		schemaType: null,
	});

	// Upgrade live-music default when experience kind is clearly non-music
	if (categorySlug === "live-music") {
		const upgraded = categorySlugFromExperienceKind(kind);
		if (upgraded && upgraded !== "live-music") {
			categorySlug = upgraded;
		}
	}

	const genres = inferEventGenres({
		title,
		description: event.description,
		categorySlug,
		artistGenres: event.genres,
	});

	const schema_type = resolveEventSchemaType({
		categorySlug,
		experienceKind: kind,
	});

	return {
		...event,
		genres,
		category_slug: categorySlug,
		category_id: ctx.categoryIdsBySlug[categorySlug] ?? null,
		schema_type,
	};
}