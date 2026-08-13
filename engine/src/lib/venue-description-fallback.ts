/**
 * Per-venue generic event body when the partner calendar has no description.
 *
 * POLICY: Do NOT invent a global one-liner for every room. Each venue that needs
 * a fallback gets its own template here (or later in DB). Unknown venues keep
 * description empty so curators / other generators can fill it.
 */

function formatEventDay(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
		timeZone: "America/Chicago",
	});
}

export type VenueDescriptionFallbackInput = {
	/** Act / show name (artist or title) */
	artistName: string;
	venueName: string;
	/** venues.slug when known */
	venueSlug?: string | null;
	startsAt: string;
	eventTitle?: string | null;
};

type FallbackFn = (input: VenueDescriptionFallbackInput) => string;

/** Slug → template. Add new venues here as pilots are trained. */
const BY_SLUG: Record<string, FallbackFn> = {
	// Hideout pilot: "{show} heads to The Hideout Theatre on {Sunday, July 6}."
	"the-hideout-theatre": (p) => {
		const who = (p.artistName || p.eventTitle || "This show").trim() || "This show";
		const date = formatEventDay(p.startsAt);
		return `${who} heads to The Hideout Theatre on ${date}.`;
	},
};

/** Name hints when slug is missing (ingestion edge cases). */
const BY_NAME: { test: RegExp; fn: FallbackFn }[] = [
	{
		test: /hideout\s+theatre/i,
		fn: BY_SLUG["the-hideout-theatre"]!,
	},
];

/**
 * Return a venue-specific generic description, or null if this venue has no template.
 */
export function venueSpecificDescriptionFallback(
	input: VenueDescriptionFallbackInput,
): string | null {
	const slug = (input.venueSlug ?? "").trim().toLowerCase();
	if (slug && BY_SLUG[slug]) {
		return BY_SLUG[slug]!(input);
	}
	const name = input.venueName ?? "";
	for (const row of BY_NAME) {
		if (row.test.test(name)) return row.fn(input);
	}
	return null;
}

/**
 * Prefer scraped body; else venue-specific fallback; else leave empty.
 */
export function resolveEventDescription(params: {
	scrapedDescription?: string | null;
	artistName: string;
	venueName: string;
	venueSlug?: string | null;
	startsAt: string;
	eventTitle?: string | null;
}): { description: string | null; source: "venue" | "generated" | "none" } {
	const scraped = (params.scrapedDescription ?? "").trim();
	if (scraped) {
		return { description: scraped, source: "venue" };
	}
	const generated = venueSpecificDescriptionFallback({
		artistName: params.artistName,
		venueName: params.venueName,
		venueSlug: params.venueSlug,
		startsAt: params.startsAt,
		eventTitle: params.eventTitle,
	});
	if (generated) {
		return { description: generated, source: "generated" };
	}
	return { description: null, source: "none" };
}
