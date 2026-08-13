export const EVENT_CATEGORY_SLUGS = [
	"live-music",
	"happy-hour",
	"food-drink",
	"festivals",
	"comedy",
	"family",
	"outdoors",
];

const VENUE_CATEGORY_DEFAULTS = {
	comedy: "comedy",
	"craft-breweries": "food-drink",
	"live-entertainment": "live-music",
};

const CATEGORY_RULES = [
	{
		slug: "comedy",
		patterns: [/\bcomedy\b/i, /\bstand[- ]?up\b/i, /\bcomedian\b/i, /\bopen mic\b/i, /\bimprov\b/i],
	},
	{ slug: "happy-hour", patterns: [/\bhappy hour\b/i, /\bteacher happy\b/i, /\bindustry night\b/i] },
	{
		slug: "food-drink",
		patterns: [/\bsip\b/i, /\bpaint\b/i, /\bcraft\b/i, /\bclass\b/i, /\bworkshop\b/i, /\bbeer release\b/i, /\bpicnic\b/i, /\bfood\b/i, /\bsolder\b/i, /\bring\b/i],
	},
	{ slug: "outdoors", patterns: [/\bvolleyball\b/i, /\bsports?\b/i, /\boutdoor\b/i, /\bpark\b/i, /\btournament\b/i] },
	{ slug: "family", patterns: [/\bfamily\b/i, /\bkids?\b/i, /\bchildren\b/i, /\ball ages\b/i] },
	{ slug: "festivals", patterns: [/\bfestival\b/i, /\bfest\b/i] },
	{ slug: "live-music", patterns: [/\bconcert\b/i, /\blive music\b/i, /\bfree concert\b/i, /\btour\b/i, /\bw\/\b/i, /\bdj\b/i, /\bbluegrass\b/i, /\bshow\b/i] },
];

const GENRES_BY_CATEGORY = {
	"live-music": ["Live Music"],
	comedy: ["Comedy"],
	"happy-hour": ["Social"],
	"food-drink": ["Food & Drink"],
	festivals: ["Festival"],
	family: ["Family"],
	outdoors: ["Outdoors"],
};

function haystack(title, description) {
	return `${title} ${description ?? ""}`.trim();
}

export function classifyEventCategorySlug({ title, description, venueCategorySlugs = [], defaultCategorySlug = null }) {
	const text = haystack(title, description);
	for (const rule of CATEGORY_RULES) {
		if (rule.patterns.some((re) => re.test(text))) return rule.slug;
	}
	if (defaultCategorySlug && EVENT_CATEGORY_SLUGS.includes(defaultCategorySlug)) return defaultCategorySlug;
	for (const venueSlug of venueCategorySlugs) {
		const mapped = VENUE_CATEGORY_DEFAULTS[venueSlug];
		if (mapped) return mapped;
	}
	return "live-music";
}

export function inferEventGenres({ title, description, categorySlug, artistGenres = [] }) {
	if (artistGenres.length) return artistGenres;
	const base = [...(GENRES_BY_CATEGORY[categorySlug] ?? ["Live Music"])];
	return [...new Set(base)].slice(0, 3);
}

export function isApprovalMetadataComplete(payload) {
	const missing = [];
	if (!payload.category_id) missing.push("category");
	if (!payload.genres?.length) missing.push("genres");
	return { ok: missing.length === 0, missing };
}