import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventCategorySlug } from "./classify-event-metadata";

export interface ClassificationContext {
	categoryIdsBySlug: Partial<Record<EventCategorySlug, string>>;
	venueCategorySlugs: string[];
	defaultCategorySlug: EventCategorySlug | null;
}

export async function loadClassificationContext(
	supabase: SupabaseClient,
	siteId: string,
	venueId: string,
	sourceId?: string | null,
): Promise<ClassificationContext> {
	const [{ data: categories }, { data: venueCats }, defaultCategorySlug] = await Promise.all([
		supabase.from("categories").select("id, slug").eq("site_id", siteId).eq("kind", "event"),
		supabase
			.from("venue_categories")
			.select("categories(slug)")
			.eq("venue_id", venueId),
		loadDefaultCategorySlug(supabase, sourceId),
	]);

	const categoryIdsBySlug: Partial<Record<EventCategorySlug, string>> = {};
	for (const row of categories ?? []) {
		categoryIdsBySlug[row.slug as EventCategorySlug] = row.id as string;
	}

	const venueCategorySlugs = (venueCats ?? [])
		.map((row) => {
			const cats = row.categories as unknown;
			if (Array.isArray(cats)) return (cats[0] as { slug?: string } | undefined)?.slug;
			return (cats as { slug?: string } | null)?.slug;
		})
		.filter((slug): slug is string => Boolean(slug));

	return {
		categoryIdsBySlug,
		venueCategorySlugs,
		defaultCategorySlug,
	};
}

async function loadDefaultCategorySlug(
	supabase: SupabaseClient,
	sourceId?: string | null,
): Promise<EventCategorySlug | null> {
	if (!sourceId) return null;

	const { data } = await supabase
		.from("venue_event_sources")
		.select("default_category_id, categories(slug)")
		.eq("id", sourceId)
		.maybeSingle();

	const cats = data?.categories as unknown;
	const slug = Array.isArray(cats)
		? (cats[0] as { slug?: string } | undefined)?.slug
		: (cats as { slug?: string } | null)?.slug;
	return (slug as EventCategorySlug | undefined) ?? null;
}