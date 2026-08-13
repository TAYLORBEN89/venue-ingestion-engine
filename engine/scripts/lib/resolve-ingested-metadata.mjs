import { classifyEventCategorySlug, inferEventGenres } from "./classify-event-metadata.mjs";

export async function loadClassificationContext(supabase, siteId, venueId) {
	const [{ data: categories }, { data: venueCats }] = await Promise.all([
		supabase.from("categories").select("id, slug").eq("site_id", siteId).eq("kind", "event"),
		supabase.from("venue_categories").select("categories(slug)").eq("venue_id", venueId),
	]);

	const categoryIdsBySlug = {};
	for (const row of categories ?? []) categoryIdsBySlug[row.slug] = row.id;

	const venueCategorySlugs = (venueCats ?? [])
		.map((row) => row.categories?.slug)
		.filter(Boolean);

	return { categoryIdsBySlug, venueCategorySlugs };
}

export async function resolveIngestedMetadata(supabase, row, payload) {
	const next = { ...payload };
	const title = payload.original_title ?? row.raw_title;

	if (!next.genres?.length && row.matched_artist_id) {
		const { data: artist } = await supabase
			.from("artists")
			.select("genres")
			.eq("id", row.matched_artist_id)
			.maybeSingle();
		if (artist?.genres?.length) next.genres = artist.genres;
	}

	if (!next.category_id && row.venue) {
		const ctx = await loadClassificationContext(supabase, row.venue.site_id, row.venue.id);
		const categorySlug = classifyEventCategorySlug({
			title,
			description: next.description,
			venueCategorySlugs: ctx.venueCategorySlugs,
		});
		next.category_slug = categorySlug;
		next.category_id = ctx.categoryIdsBySlug[categorySlug] ?? null;
	}

	if (!next.genres?.length) {
		next.genres = inferEventGenres({
			title,
			description: next.description,
			categorySlug: next.category_slug ?? "live-music",
			artistGenres: next.genres ?? [],
		});
	}

	return next;
}