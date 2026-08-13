/**
 * Template-based event SEO for every ingest (no LLM).
 * Kind-aware: comedy / sports / food never use "live music" or "live at" framing.
 */

import {
	inferVenueExperienceKind,
	type VenueExperienceKind,
} from "./event-intro";

/** Yoast-style meta description band. */
const META_DESC_MIN = 120;
const META_DESC_MAX = 155;

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	const cut = text.slice(0, maxLen - 1);
	const lastSpace = cut.lastIndexOf(" ");
	return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxLen - 1)}…`;
}

/** Keep at most one "HeyAustin" mention (case-insensitive). */
function limitHeyAustinMentions(text: string): string {
	let seen = false;
	return text.replace(/\bHeyAustin\b/gi, (match) => {
		if (seen) return "the listing";
		seen = true;
		return match;
	});
}

/**
 * Keep meta descriptions in the 120–155 character band.
 * Brand "HeyAustin" at most once — no stacked brand-pad stuffing.
 */
function fitMetaDescription(text: string): string {
	const base = text.replace(/\s+/g, " ").trim();
	if (base.length > META_DESC_MAX) return truncate(limitHeyAustinMentions(base), META_DESC_MAX);
	if (base.length >= META_DESC_MIN) return limitHeyAustinMentions(base);

	const hasBrand = /\bheyaustin\b/i.test(base);
	// Longer single pads so one append usually hits 120–155 chars (no stacking).
	const pads = hasBrand
		? [
				" Get tickets, show times, lineup details, and venue info for this Austin event.",
				" Find tickets, doors/show time, and full event details for this listing.",
				" Plan your night with tickets, schedule, and venue information here.",
			]
		: [
				" Tickets, times, and full event details on HeyAustin.",
				" Get tickets, show times, and venue info for this Austin listing.",
				" Find tickets, doors/show time, and full event details here.",
			];

	for (const pad of pads) {
		const next = limitHeyAustinMentions(
			`${base.replace(/\.$/, "")}.${pad}`.replace(/\.\./g, "."),
		);
		if (next.length >= META_DESC_MIN && next.length <= META_DESC_MAX) return next;
		if (next.length > META_DESC_MAX) {
			const trimmed = truncate(next, META_DESC_MAX);
			if (trimmed.length >= META_DESC_MIN) return trimmed;
		}
	}

	let expanded = limitHeyAustinMentions(
		`${base.replace(/\.$/, "")}. Get tickets, times, and full event details on the listing.`.replace(
			/\.\./g,
			".",
		),
	);
	while (expanded.length < META_DESC_MIN) {
		expanded = `${expanded.replace(/\.$/, "")} More show info available.`;
		if (expanded.length > META_DESC_MAX) return truncate(expanded, META_DESC_MAX);
	}
	return expanded.length > META_DESC_MAX ? truncate(expanded, META_DESC_MAX) : expanded;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

export interface EventSeoFields {
	focus_keyphrase: string;
	seo_title: string;
	seo_description: string;
}

function seoVerbForKind(kind: VenueExperienceKind): string {
	switch (kind) {
		case "comedy":
			return "performs comedy at";
		case "sports":
			return "watch party at";
		case "music":
			return "live at";
		case "theater":
			return "on stage at";
		default:
			return "at";
	}
}

function keyphraseTailForKind(kind: VenueExperienceKind, city: string): string {
	switch (kind) {
		case "comedy":
			return `${city} comedy`;
		case "sports":
			return `${city} watch party`;
		case "music":
			return `${city} live music`;
		case "theater":
			return `${city} theater`;
		case "festival":
			return `${city} festival`;
		case "brewery":
			return `${city} brewery event`;
		default:
			return city;
	}
}

/** Strip partner "Live Music:" prefixes so brunch/comedy SEO is not polluted. */
function cleanTitleForSeo(title: string, kind: VenueExperienceKind): string {
	let t = title.trim() || "Event";
	if (kind === "music") return t;
	t = t.replace(/^live\s*music\s*[:\-–—]\s*/i, "").trim();
	t = t.replace(/^live\s*music\s+/i, "").trim();
	return t || title.trim() || "Event";
}

/** Always-on event SEO for staged ingests. */
export function generateEventSeo(params: {
	title: string;
	venueName: string;
	city: string;
	brandName: string;
	startsAt: string;
	priceText?: string | null;
	/** Preferred when already classified */
	experienceKind?: VenueExperienceKind | string | null;
	venueDescription?: string | null;
	venueCategorySlugs?: string[];
	genres?: string[];
	schemaType?: string | null;
}): EventSeoFields {
	const { title, venueName, city, brandName, startsAt, priceText } = params;
	const rawTitle = title.trim() || "Event";
	const safeVenue = venueName.trim() || "Austin";
	const safeCity = city.trim() || "Austin";
	const safeBrand = brandName.trim() || "HeyAustin";

	const kind: VenueExperienceKind =
		(params.experienceKind as VenueExperienceKind) ||
		inferVenueExperienceKind({
			venueName: safeVenue,
			venueDescription: params.venueDescription,
			venueCategorySlugs: params.venueCategorySlugs,
			eventTitle: rawTitle,
			genres: params.genres,
			schemaType: params.schemaType,
		});

	const safeTitle = cleanTitleForSeo(rawTitle, kind);

	const focus_keyphrase = truncate(
		`${safeTitle} ${keyphraseTailForKind(kind, safeCity)}`.replace(/\s+/g, " ").trim(),
		80,
	);
	const seo_title = truncate(`${safeTitle} | ${safeVenue} ${safeCity} | ${safeBrand}`, 60);

	const dateStr = formatDate(startsAt);
	const priceSuffix = priceText ? ` ${priceText}.` : "";
	const verb = seoVerbForKind(kind);
	const seo_description = fitMetaDescription(
		`${safeTitle} ${verb} ${safeVenue} in ${safeCity} on ${dateStr}.${priceSuffix}`,
	);

	return { focus_keyphrase, seo_title, seo_description };
}
