/**
 * Match titles to non-artist event_series stubs (mirrors admin match-event-series).
 */

export type EventSeriesRow = {
	id: string;
	name: string;
	slug: string;
	match_patterns: string[] | null;
	venue_id: string | null;
	status: string;
};

function normalize(s: string): string {
	return String(s || "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/&#x27;|&apos;|'/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function normalizeTitleForSeriesMatch(title: string): string {
	let t = normalize(title);
	t = t.replace(/^(sold out|cancelled|canceled|postponed|rescheduled|new date)\s+/i, "");
	t = t.replace(/^(free concert|live music|live|concert|music|show|special event)\s+/i, "");
	return t.trim();
}

export function matchEventSeries(
	title: string,
	catalog: EventSeriesRow[],
	opts?: { venueId?: string | null },
): EventSeriesRow | null {
	const hay = normalizeTitleForSeriesMatch(title);
	if (!hay || catalog.length === 0) return null;

	const venueId = opts?.venueId ?? null;
	let best: { row: EventSeriesRow; score: number } | null = null;

	for (const row of catalog) {
		if (row.status !== "published") continue;
		if (row.venue_id && venueId && row.venue_id !== venueId) continue;
		if (row.venue_id && !venueId) continue;

		const patterns = Array.isArray(row.match_patterns) ? row.match_patterns : [];
		const candidates = [row.name, ...patterns].map(normalize).filter(Boolean);
		for (const p of candidates) {
			if (!p || !hay.includes(p)) continue;
			let score = p.length;
			if (row.venue_id && venueId && row.venue_id === venueId) score += 100;
			if (hay.startsWith(p)) score += 20;
			if (!best || score > best.score) best = { row, score };
		}
	}

	return best?.row ?? null;
}

export async function loadPublishedSeriesCatalog(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	supabase: { from: (t: string) => any },
	siteId: string,
): Promise<EventSeriesRow[]> {
	const { data, error } = await supabase
		.from("event_series")
		.select("id, name, slug, match_patterns, venue_id, status")
		.eq("site_id", siteId)
		.eq("status", "published")
		.is("deleted_at", null);
	if (error) {
		// Table may not exist on older envs
		console.warn("event_series load failed:", error.message);
		return [];
	}
	return (data ?? []) as EventSeriesRow[];
}
