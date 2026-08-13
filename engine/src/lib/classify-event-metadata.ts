/** Curated HeyAustin event category slugs (kind='event'). */
export type EventCategorySlug =
	| "live-music"
	| "happy-hour"
	| "food-drink"
	| "festivals"
	| "comedy"
	| "family"
	| "outdoors";

export const EVENT_CATEGORY_SLUGS: EventCategorySlug[] = [
	"live-music",
	"happy-hour",
	"food-drink",
	"festivals",
	"comedy",
	"family",
	"outdoors",
];

/** Public category chip → schema.org type (JSON-LD). Keep in sync with admin event-schema-from-category. */
export const EVENT_SCHEMA_BY_CATEGORY: Record<EventCategorySlug, string> = {
	"live-music": "MusicEvent",
	comedy: "ComedyEvent",
	festivals: "Festival",
	"food-drink": "FoodEvent",
	"happy-hour": "Event",
	family: "Event",
	outdoors: "Event",
};

export function schemaTypeFromEventCategorySlug(
	slug: string | null | undefined,
): string {
	const key = (slug || "").trim().toLowerCase() as EventCategorySlug;
	return EVENT_SCHEMA_BY_CATEGORY[key] ?? "Event";
}

/** Experience kind → schema.org type (keep in sync with admin event-schema-from-category). */
export function schemaTypeFromExperienceKind(
	kind: string | null | undefined,
): string {
	switch ((kind || "").toLowerCase()) {
		case "comedy":
			return "ComedyEvent";
		case "sports":
			return "SportsEvent";
		case "music":
			return "MusicEvent";
		case "theater":
			return "TheaterEvent";
		case "festival":
			return "Festival";
		case "brewery":
		case "restaurant":
		case "happy_hour":
			return "FoodEvent";
		case "outdoors":
		case "family":
		case "general":
		default:
			return "Event";
	}
}

/**
 * Prefer specific non-MusicEvent signals when category and kind disagree.
 * category live-music (default) + kind comedy → ComedyEvent.
 */
export function resolveEventSchemaType(input: {
	categorySlug?: string | null;
	experienceKind?: string | null;
}): string {
	const catKey = (input.categorySlug || "").trim().toLowerCase();
	const fromCat = catKey ? (EVENT_SCHEMA_BY_CATEGORY[catKey as EventCategorySlug] ?? null) : null;
	const fromKind = input.experienceKind
		? schemaTypeFromExperienceKind(input.experienceKind)
		: null;

	if (
		fromKind &&
		fromKind !== "MusicEvent" &&
		fromKind !== "Event" &&
		(!fromCat || fromCat === "MusicEvent" || fromCat === "Event" || fromCat === fromKind)
	) {
		return fromKind;
	}
	if (
		fromCat &&
		fromCat !== "MusicEvent" &&
		fromCat !== "Event" &&
		(!fromKind || fromKind === "MusicEvent" || fromKind === "Event" || fromKind === fromCat)
	) {
		return fromCat;
	}
	if (fromKind && fromCat && fromKind !== fromCat) {
		if (fromKind !== "MusicEvent" && fromKind !== "Event") return fromKind;
		if (fromCat !== "MusicEvent") return fromCat;
	}
	// Weak live-music category must not override non-music kinds (trivia, brewery, general)
	if (fromCat === "MusicEvent" && fromKind && fromKind !== "MusicEvent") {
		return fromKind;
	}
	if (fromKind === "MusicEvent" || fromCat === "MusicEvent") return "MusicEvent";
	return fromKind || fromCat || "Event";
}

/** Map experience kind → public event category slug (upgrade live-music defaults). */
export function categorySlugFromExperienceKind(
	kind: string | null | undefined,
): EventCategorySlug | null {
	switch ((kind || "").toLowerCase()) {
		case "comedy":
			return "comedy";
		case "festival":
			return "festivals";
		case "brewery":
		case "restaurant":
		case "happy_hour":
			return "food-drink";
		case "outdoors":
		case "sports":
			return "outdoors";
		case "family":
			return "family";
		case "music":
			return "live-music";
		default:
			return null;
	}
}

/**
 * Title-first classification. Artist bios often contain weak tokens
 * ("festival appearances", "as a kid", "funny") that must not steal category.
 * Venue food/alcohol alone ≠ Food & Drink. Only real comedy rooms force comedy.
 */
const COMEDY_VENUE_SLUGS = new Set([
	"the-velveeta-room",
	"the-hideout-theatre",
	"latchkey",
	"esther-s-follies-comedy-theater",
	"moontower-comedy",
	"cap-city-comedy-club",
	"cap-city-comedy",
]);

const COMEDY_VENUE_NAME_RE =
	/\b(cap city|velveeta|esther'?s?\s*follies|hideout theatre|moontower comedy|comedy club)\b/i;

const GENRES_BY_CATEGORY: Record<EventCategorySlug, string[]> = {
	"live-music": ["Live Music"],
	comedy: ["Comedy"],
	"happy-hour": ["Social"],
	"food-drink": ["Food & Drink"],
	festivals: ["Festival"],
	family: ["Family"],
	outdoors: ["Outdoors"],
};

function haystack(title: string, description?: string | null): string {
	return `${title} ${description ?? ""}`.trim();
}

function titleIsComedy(title: string): boolean {
	return (
		/\bcomedy\b/i.test(title) ||
		/\bstand[- ]?up\b/i.test(title) ||
		/\bcomedian\b/i.test(title) ||
		/\bimprov\b/i.test(title) ||
		/\broast\b/i.test(title) ||
		/\bpunchline\b/i.test(title) ||
		/\blaugh\s*(factory|night|lounge)\b/i.test(title) ||
		(/\bopen[\s-]?mic\b/i.test(title) && /\b(comedy|stand|improv|comic)\b/i.test(title))
	);
}

function titleIsHappyHour(title: string): boolean {
	return (
		/\bhappy[\s-]?hour\b/i.test(title) ||
		/\bteacher happy\b/i.test(title) ||
		/\bindustry (night|hour)\b/i.test(title)
	);
}

function titleIsFestival(title: string): boolean {
	return (
		/\bfestivals?\b/i.test(title) ||
		/\bmusic\s+fest\b/i.test(title) ||
		/\bfest\s*['’]?\s*\d{2,4}\b/i.test(title) ||
		/\blevitation\b/i.test(title) ||
		/\bacl fest\b/i.test(title) ||
		/\bsxsw\b/i.test(title) ||
		/\bcrossroads guitar festival\b/i.test(title)
	);
}

function titleIsFamily(title: string): boolean {
	return (
		/\bfamily[- ]friendly\b/i.test(title) ||
		/\bfamily (show|night|fun|day|event|matinee)\b/i.test(title) ||
		/\bfor (kids|children|families)\b/i.test(title) ||
		/\bkids?\s+(show|concert|day|night|club|matinee|crafts?)\b/i.test(title) ||
		/\bchildren'?s?\s+(show|concert|theatre|theater|hour)\b/i.test(title) ||
		/\bstory[\s-]?time\b/i.test(title) ||
		/\bpuppet\b/i.test(title) ||
		/\btoddler\b/i.test(title) ||
		/^annie\b/i.test(title.trim()) ||
		/\bnutcracker\b/i.test(title) ||
		/\bdude perfect\b/i.test(title)
	);
}

function titleIsOutdoors(title: string): boolean {
	return (
		/\bvolleyball\b/i.test(title) ||
		/\b(trail\s*)?hike\b/i.test(title) ||
		/\b5k\b/i.test(title) ||
		/\b10k\b/i.test(title) ||
		/\bmarathon\b/i.test(title) ||
		/\bpaddle\b/i.test(title) ||
		/\bkayak\b/i.test(title) ||
		/\bcanoe\b/i.test(title) ||
		/\bguided goat walk\b/i.test(title) ||
		(/\btournament\b/i.test(title) && !/\b(band|music|dj)\b/i.test(title))
	);
}

function titleIsLiveMusic(title: string): boolean {
	return (
		/\blive music\b/i.test(title) ||
		/\bconcert\b/i.test(title) ||
		/\btour\b/i.test(title) ||
		/\bdj\b/i.test(title) ||
		/\bband\b/i.test(title) ||
		/\bjazz|blues|country|bluegrass|punk|metal|indie|hip[- ]?hop|americana|folk|funk|soul\b/i.test(
			title,
		) ||
		/\bsinger[- ]?songwriter\b/i.test(title) ||
		/\bkaraoke\b/i.test(title) ||
		/\bsongwriter/i.test(title) ||
		/\bw\//i.test(title) ||
		/\bpresents\b/i.test(title)
	);
}

function titleIsSocialOrFood(title: string): boolean {
	return (
		/\b(trivia|quiz|bingo|watch party|book (swap|fair)|workshop|pottery|yoga|night market)\b/i.test(
			title,
		) ||
		/\bsip\s*(&|and)\s*sculpt\b/i.test(title) ||
		/\bpaint\s*(&|and)\s*sip\b/i.test(title) ||
		/\bcrawfish|boil|brunch|wine tasting|beer (release|tasting)|food truck|cooking class|pot\s*2\s*plate|oysters?\b/i.test(
			title,
		) ||
		/\bnational (chicken wing|cheeseburger|taco|pizza|burger|ipa)\s+day\b/i.test(title) ||
		/\bmargaritas?\b/i.test(title)
	);
}

export function classifyEventCategorySlug(input: {
	title: string;
	description?: string | null;
	venueCategorySlugs?: string[];
	defaultCategorySlug?: string | null;
	venueSlug?: string | null;
	venueName?: string | null;
}): EventCategorySlug {
	const t = (input.title || "").trim();
	const descHead = (input.description || "").slice(0, 280);
	const venueSlug = (input.venueSlug || "").toLowerCase();
	const venueName = input.venueName || "";
	const isComedyVenue =
		COMEDY_VENUE_SLUGS.has(venueSlug) || COMEDY_VENUE_NAME_RE.test(venueName);

	if (titleIsComedy(t)) return "comedy";
	if (titleIsFestival(t)) return "festivals";
	if (titleIsHappyHour(t)) {
		if (/\b(ft\.|feat\.|with|songwriter|song\s*swap|music)\b/i.test(t) || /\bw\//i.test(t) || titleIsLiveMusic(t)) {
			return "live-music";
		}
		return "happy-hour";
	}
	if (titleIsFamily(t)) return "family";
	if (titleIsOutdoors(t)) return "outdoors";
	if (titleIsSocialOrFood(t) && !titleIsLiveMusic(t)) return "food-drink";
	if (titleIsLiveMusic(t)) return "live-music";

	if (isComedyVenue) {
		if (/\b(brunch|dinner|private|closed|hours)\b/i.test(t)) return "food-drink";
		return "comedy";
	}
	if (/\bopen[\s-]?mic\b/i.test(t) && !/\b(music|band|singer|guitar|song)\b/i.test(t)) {
		return "comedy";
	}

	// Strong event-blurb signals only (not full artist bio)
	if (/\b(stand[- ]?up comedy|comedy show|comedian)\b/i.test(descHead)) return "comedy";
	if (/\b(crawfish boil|wine tasting|beer release|food truck)\b/i.test(descHead) && !/\blive music\b/i.test(descHead)) {
		return "food-drink";
	}

	if (input.defaultCategorySlug && EVENT_CATEGORY_SLUGS.includes(input.defaultCategorySlug as EventCategorySlug)) {
		return input.defaultCategorySlug as EventCategorySlug;
	}

	const vc = input.venueCategorySlugs ?? [];
	// Never map venue "comedy" category alone — many music rooms were mis-tagged.
	if (vc.includes("craft-breweries") || vc.includes("restaurants") || vc.includes("coffee")) {
		if (titleIsSocialOrFood(t)) return "food-drink";
	}
	if (vc.includes("live-entertainment")) return "live-music";

	return "live-music";
}

export function inferEventGenres(input: {
	title: string;
	description?: string | null;
	categorySlug: EventCategorySlug;
	artistGenres?: string[];
}): string[] {
	if (input.artistGenres?.length) return input.artistGenres;

	const text = haystack(input.title, input.description);
	const base = [...(GENRES_BY_CATEGORY[input.categorySlug] ?? ["Live Music"])];

	if (input.categorySlug === "live-music") {
		if (/\bcountry\b/i.test(text)) base.push("Country");
		if (/\bblues\b/i.test(text)) base.push("Blues");
		if (/\brock\b/i.test(text)) base.push("Rock");
		if (/\bindie\b/i.test(text)) base.push("Indie");
		if (/\bjazz\b/i.test(text)) base.push("Jazz");
		if (/\bhip[- ]?hop\b/i.test(text)) base.push("Hip-Hop");
		if (/\belectronic\b/i.test(text)) base.push("Electronic");
		if (/\bbluegrass\b/i.test(text)) base.push("Bluegrass");
	}

	return [...new Set(base)].slice(0, 3);
}

export function isApprovalMetadataComplete(payload: {
	genres?: string[];
	category_id?: string | null;
}): { ok: boolean; missing: string[] } {
	const missing: string[] = [];
	if (!payload.category_id) missing.push("category");
	if (!payload.genres?.length) missing.push("genres");
	return { ok: missing.length === 0, missing };
}