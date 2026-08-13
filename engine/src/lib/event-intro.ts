export type VenueExperienceKind =
	| "comedy"
	| "brewery"
	| "restaurant"
	| "happy_hour"
	| "festival"
	| "outdoors"
	| "family"
	| "theater"
	| "music"
	| "sports"
	| "general";

export interface EventIntroContext {
	artistName: string;
	venueName: string;
	venueDescription?: string | null;
	/** Venue taxonomy slugs (e.g. comedy, craft-breweries) — tailor copy per room */
	venueCategorySlugs?: string[];
	/** Partner/event title — helps classify the night */
	eventTitle?: string | null;
	genres?: string[];
	startsAt: string;
	city?: string | null;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
		timeZone: "America/Chicago",
	});
}

function firstSentence(text: string): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	const match = trimmed.match(/^[^.!?]+[.!?]/);
	return match ? match[0].trim() : trimmed.slice(0, 140).trim();
}

/**
 * Infer what kind of room/night this is so auto-gen does not assume live music.
 * Order matters: more specific venue types first.
 */
export function inferVenueExperienceKind(input: {
	venueName: string;
	venueDescription?: string | null;
	venueCategorySlugs?: string[];
	eventTitle?: string | null;
	genres?: string[];
	/** schema.org type when known (ComedyEvent, MusicEvent, …) */
	schemaType?: string | null;
}): VenueExperienceKind {
	const cats = (input.venueCategorySlugs ?? []).map((s) => s.toLowerCase());
	const schema = (input.schemaType ?? "").toLowerCase();
	const blob = [
		input.venueName,
		input.venueDescription ?? "",
		input.eventTitle ?? "",
		...(input.genres ?? []),
		...cats,
		schema,
	]
		.join(" ")
		.toLowerCase();

	const hasCat = (...keys: string[]) => keys.some((k) => cats.some((c) => c.includes(k)));
	const genres = input.genres ?? [];
	const hasComedyGenre = genres.some((g) => /\bcomedy\b|\bstand[- ]?up\b|\bimprov\b/i.test(g));
	const hasMusicGenre = genres.some(
		(g) =>
			!/\bcomedy\b|\bstand[- ]?up\b|\bimprov\b|\bspoken\b|\bpodcast\b/i.test(g) &&
			/\b(music|rock|country|jazz|blues|folk|punk|metal|soul|funk|americana|bluegrass|hip[- ]?hop|r&b|indie|singer|band|honky)\b/i.test(
				g,
			),
	);

	// Comedy: strong signals only (club / title / genre / schema) — not a word buried in venue prose
	const titleBlob = `${input.eventTitle ?? ""} ${input.genres?.join(" ") ?? ""}`.toLowerCase();
	const venueBlob = `${input.venueName} ${input.venueDescription ?? ""}`.toLowerCase();
	const comedyClubVenue =
		/\bcap city comedy\b|\besther'?s follies\b|\bvelveeta\b|\bcomedy club\b|\bcomedy theater\b|\bcomedy theatre\b|\bmoontower comedy\b/i.test(
			venueBlob,
		);
	// Avoid album/tour titles like "Comedy Tragedy Parody" — require comedy *show* signals
	const comedyInTitle =
		/\b(stand[- ]?up|improv|comedian|kill tony|funniest person|red room at cap city|comedy (show|night|hour|club|open mic|troupe|festival)|open mic comedy)\b/i.test(
			titleBlob,
		) ||
		(/\bcomedy\b/i.test(titleBlob) &&
			/\b(show|night|hour|club|open mic|troupe|special|tour dates)\b/i.test(titleBlob) &&
			!/\b(tragedy|parody|album|ep|lp|record|tour)\b/i.test(titleBlob));
	// Schema ComedyEvent alone is not enough — many music nights are mis-tagged.
	if (hasComedyGenre || hasCat("comedy") || comedyClubVenue || comedyInTitle) {
		return "comedy";
	}
	const knownMusicRoom =
		/\bacl live\b|\bmoody (center|theater|theatre)\b|\bstubb'?s\b|\bantone'?s\b|\bcontinental club\b|\bflamingo cantina\b|\bsaxon pub\b|\belephant room\b|\bcactus cafe\b|\bhotel vegas\b|\bwhite horse\b|\bcome and take it\b/i.test(
			venueBlob,
		);
	if (schema.includes("comedy") && !knownMusicRoom) {
		return "comedy";
	}
	// Title-only sports — not every sports-bar venue blurb
	if (
		schema.includes("sport") ||
		/\bwatch party\b|\bworld cup\b|\bgame day\b|\bdallas cowboys\b|\bcowboys vs\b/i.test(titleBlob)
	) {
		return "sports";
	}
	// Title-driven brunch / market nights before music-venue defaults
	if (
		/\b(gospel brunch|jazz brunch|drag brunch)\b/i.test(titleBlob) ||
		(/\bbrunch\b/i.test(titleBlob) && !/\b(concert|tour)\b/i.test(input.eventTitle ?? ""))
	) {
		return "restaurant";
	}
	if (/\b(trivia|bingo|workshop|market|bazaar)\b/i.test(titleBlob)) {
		return "general";
	}

	// Strong music signals early — before happy_hour/outdoors/family from venue prose
	const musicVenueName =
		/\bacl live\b|\bmoody (center|theater|theatre|amphitheatr)\b|\bstubb'?s\b|\bantone'?s\b|\bcontinental club\b|\bparamount theatre\b|\bbass concert\b|\berwin center\b|\bthe long center\b|\bwhite horse\b|\belephant room\b|\bflamingo cantina\b|\bsaxon pub\b|\bcactus cafe\b|\bhotel vegas\b|\bfar out lounge\b|\bcome and take it\b|\bhole in the wall\b|\bempire control\b/i.test(
			venueBlob,
		);
	const titleLooksLikeConcert =
		/\b(live music|concert|tour|residency|trio|quartet|orchestra|band|dj)\b/i.test(titleBlob) ||
		/^live\s*music\s*[:\-–—]/i.test(input.eventTitle ?? "");
	if (
		hasMusicGenre ||
		hasCat("live-entertainment", "music", "honky") ||
		schema === "musicevent" ||
		musicVenueName ||
		titleLooksLikeConcert ||
		/\blive music\b|\bconcert\b|\bhonky[- ]?tonk\b|\bdance hall\b|\blistening room\b|\bmusic venue\b|\bjazz club\b/.test(
			blob,
		)
	) {
		return "music";
	}

	if (hasCat("craft-breweries", "brewery") || /\bbrewery\b|\bbrewing\b|\btaproom\b|\bbeer garden\b/.test(blob)) {
		return "brewery";
	}
	if (hasCat("happy-hour") || /\bhappy hour\b|\bindustry night\b|\bindustry hour\b/i.test(titleBlob)) {
		return "happy_hour";
	}
	if (schema.includes("festival") || hasCat("festival") || /\bfestival\b|\bfest\b/.test(titleBlob)) {
		return "festival";
	}
	if (
		hasCat("outdoors") ||
		/\bvolleyball\b|\bhike\b|\brun club\b|\btrail\b/i.test(titleBlob) ||
		(/\boutdoor\b/i.test(titleBlob) && !musicVenueName)
	) {
		return "outdoors";
	}
	if (hasCat("family") || /\b(kids?|children|storytime|all ages)\b/i.test(titleBlob)) {
		return "family";
	}
	// Theater shows only with real drama/play signals — not every room named "Theater"
	const theaterInTitle =
		/\b(play|musical|drama|ballet|opera|shakespeare|one-act)\b/i.test(titleBlob);
	if (
		schema.includes("theater") ||
		schema.includes("theatre") ||
		hasCat("theater", "theatre") ||
		theaterInTitle ||
		(/\b(playhouse|repertory|rep theatre|rep theater)\b/i.test(venueBlob) && !musicVenueName)
	) {
		return "theater";
	}
	if (
		schema.includes("food") ||
		hasCat("restaurant", "food", "dining") ||
		(/\brestaurant\b|\bkitchen\b|\bdining\b|\bbrunch\b|\bgospel brunch\b|\bjazz brunch\b/.test(blob) &&
			!/\bmusic venue\b|\bclub\b|\bhonky\b/.test(blob))
	) {
		return "restaurant";
	}
	return "general";
}

/** What the night is about — never default everything to "live music". */
function activityPhrase(kind: VenueExperienceKind, genres: string[]): string {
	if (genres.length === 1) return genres[0].toLowerCase();
	if (genres.length >= 2) return `${genres[0].toLowerCase()} and ${genres[1].toLowerCase()}`;

	switch (kind) {
		case "comedy":
			return "comedy";
		case "brewery":
			return "a night at the brewery";
		case "happy_hour":
			return "happy hour";
		case "festival":
			return "festival programming";
		case "outdoors":
			return "an outdoor event";
		case "family":
			return "a family-friendly event";
		case "theater":
			return "a stage performance";
		case "restaurant":
			return "a special evening";
		case "music":
			return "live music";
		case "sports":
			return "a watch party";
		default:
			return "an event";
	}
}

function venueHook(
	kind: VenueExperienceKind,
	venueName: string,
	venueDescription: string | null | undefined,
	city: string | null | undefined,
): string {
	if (venueDescription && venueDescription.trim().length > 40) {
		return firstSentence(venueDescription);
	}
	const place = city?.trim() || "Austin";
	switch (kind) {
		case "comedy":
			return `${venueName} is a comedy room in ${place}.`;
		case "brewery":
			return `${venueName} is a craft brewery in ${place}.`;
		case "happy_hour":
			return `${venueName} is a go-to spot for after-work gatherings in ${place}.`;
		case "festival":
			return `${venueName} hosts festival programming in ${place}.`;
		case "outdoors":
			return `${venueName} is an outdoor venue in ${place}.`;
		case "family":
			return `${venueName} welcomes families in ${place}.`;
		case "theater":
			return `${venueName} is a theater in ${place}.`;
		case "restaurant":
			return `${venueName} is a dining destination in ${place}.`;
		case "music":
			return `${venueName} is a live music venue in ${place}.`;
		case "sports":
			return `${venueName} is a great place to catch the game in ${place}.`;
		default:
			return `${venueName} is a well-known venue in ${place}.`;
	}
}

function pickTemplateIndex(seed: string, count: number): number {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) {
		hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
	}
	return hash % count;
}

function templatesForKind(
	kind: VenueExperienceKind,
	artistName: string,
	venueName: string,
	date: string,
	activity: string,
	hook: string,
): string[] {
	const hookTail = hook.charAt(0).toLowerCase() + hook.slice(1);

	// Comedy club: stand-up language only — never "live music" / concert framing
	if (kind === "comedy") {
		const night =
			activity === "comedy" || activity === "an event"
				? "stand-up comedy"
				: activity;
		return [
			`${artistName} returns to ${venueName} on ${date} for a night of ${night}. ${hook}`,
			`${artistName} brings ${night} to ${venueName} on ${date}. ${hook}`,
			`On ${date}, catch ${artistName} at ${venueName} for ${night}. ${hook}`,
			`${artistName} hits the mic at ${venueName} on ${date} — ${night} in an intimate room. ${hook}`,
			`${artistName} is on the bill at ${venueName} on ${date}. ${hook}`,
		];
	}

	if (kind === "sports") {
		return [
			`${artistName} at ${venueName} on ${date}. ${hook}`,
			`Catch ${artistName} at ${venueName} on ${date}. ${hook}`,
			`On ${date}, ${venueName} hosts ${artistName}. ${hook}`,
		];
	}

	if (kind === "brewery" || kind === "restaurant" || kind === "happy_hour") {
		return [
			`${artistName} is at ${venueName} on ${date} for ${activity}. ${hook}`,
			`Join ${artistName} at ${venueName} on ${date}. ${hook}`,
			`On ${date}, ${venueName} hosts ${artistName}. ${hook}`,
			`${artistName} at ${venueName} on ${date} — ${activity}. ${hook}`,
			`${artistName} heads to ${venueName} on ${date}. ${hook}`,
		];
	}

	if (kind === "music") {
		return [
			`${artistName} returns to ${venueName} on ${date} for an evening of ${activity}. ${hook}`,
			`${artistName} brings ${activity} to ${venueName} on ${date}. ${hook}`,
			`On ${date}, ${artistName} takes the stage at ${venueName} with ${activity}. ${hook}`,
			`Catch ${artistName} at ${venueName} on ${date} — ${activity} and a welcoming room. ${hook}`,
			`${artistName} heads to ${venueName} on ${date}, delivering ${activity} in a setting ${hookTail}`,
		];
	}

	// General / festival / outdoors / family / theater — neutral show language
	return [
		`${artistName} is at ${venueName} on ${date} for ${activity}. ${hook}`,
		`${artistName} comes to ${venueName} on ${date}. ${hook}`,
		`On ${date}, catch ${artistName} at ${venueName}. ${hook}`,
		`${artistName} at ${venueName} on ${date} — ${activity}. ${hook}`,
		`${artistName} heads to ${venueName} on ${date}. ${hook}`,
	];
}

/**
 * Template-based opener tailored to the venue type.
 * Uses venue description as the identity hook when present; otherwise
 * kind-specific fallbacks (comedy club, brewery, music room, general venue).
 * Does not assume every listing is live music.
 */
export function generateEventIntro(ctx: EventIntroContext): string {
	const kind = inferVenueExperienceKind({
		venueName: ctx.venueName,
		venueDescription: ctx.venueDescription,
		venueCategorySlugs: ctx.venueCategorySlugs,
		eventTitle: ctx.eventTitle ?? ctx.artistName,
		genres: ctx.genres,
	});
	const date = formatDate(ctx.startsAt);
	const activity = activityPhrase(kind, ctx.genres ?? []);
	const hook = venueHook(kind, ctx.venueName, ctx.venueDescription, ctx.city);
	const seed = `${ctx.artistName}|${ctx.venueName}|${ctx.startsAt}|${kind}`;
	const templates = templatesForKind(kind, ctx.artistName, ctx.venueName, date, activity, hook);
	return templates[pickTemplateIndex(seed, templates.length)];
}
