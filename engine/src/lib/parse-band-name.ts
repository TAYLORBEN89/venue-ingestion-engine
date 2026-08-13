const TITLE_PREFIXES = [
	/^free\s+concert\s*:\s*/i,
	/^live\s+music\s*:\s*/i,
	/^live\s*:\s*/i,
	/^concert\s*:\s*/i,
	/^music\s*:\s*/i,
	/^show\s*:\s*/i,
	/^presents?\s*:\s*/i,
];

const TITLE_SUFFIXES = [
	/\s+live$/i,
	/\s+in\s+concert$/i,
	/\s+tour$/i,
];

const STATUS_PREFIXES = [
	/^(?:SOLD\s+OUT|CANCELLED|CANCELED|POSTPONED|RESCHEDULED|NEW\s+DATE)\s*[-–—:]\s*/i,
];

/** Venue calendar branding before the billed artist, e.g. "Antone's 51st Anniversary:" */
const VENUE_BRANDING_PREFIXES = [
	/^antone['\u2019]s(?:\s+nightclub)?(?:\s+\d+(?:st|nd|rd|th)?\s+anniversary)?\s*:\s*/i,
	/^[^:]{0,80}anniversary\s*:\s*/i,
];

/**
 * Recurring series / event-format names where the real act follows "w/" or "with".
 * These are NOT artists — e.g. "Gospel Brunch w/ The Levites" → headliner The Levites.
 */
const EVENT_SERIES_NAMES = new Set(
	[
		"blue monday",
		"jerryfest",
		"tap ya toe jam",
		"school of rock",
		"gospel brunch",
		"sing along saturdays",
		"sing along saturday",
		"string theory thursday",
		"string theory",
		"double vision",
		"industry night",
		"open mic",
		"karaoke night",
		"trivia night",
		"ladies night",
		"cumbia night",
	].map((s) => s.toLowerCase()),
);

/** Loose patterns for event-format labels (not band names). */
const EVENT_SERIES_PATTERNS = [
	/\bgospel\s+brunch\b/i,
	/\bbrunch\b/i, // "Sunday Brunch w/ X" — act is after w/
	/\bsing\s+along\b/i,
	/\bopen\s+mic\b/i,
	/\bindustry\s+night\b/i,
	/\bwatch\s+party\b/i,
	/\bjam\s+night\b/i,
	/\bsongwriter\s+night\b/i,
	/\bresidency\s+night\b/i,
];

const NOISE_PARENTHETICALS =
	/\s*\((?:FULL\s+BAND|Closing\s+Night|NIGHT\s+(?:ONE|TWO|THREE))\)\s*/gi;

/**
 * Lineup / cast in parens is not the catalog name:
 * "Sex Pistols (Steve Jones, Paul Cook, Glen Matlock)" → "Sex Pistols"
 * Keep short intentional names like "Cher (with friends)" only when not a name list.
 */
function stripLineupParentheticals(title: string): string {
	// Name list or "feat members" inside parens
	const stripped = title
		.replace(
			/\s*\(([^)]{0,120})\)\s*/g,
			(full, inner: string) => {
				const t = String(inner || "").trim();
				if (!t) return " ";
				// Member lists: commas, & , "feat", multiple capitalized tokens
				if (
					/,/.test(t) ||
					/\b(?:feat\.?|featuring|ft\.?|with|w\/)\b/i.test(t) ||
					/\band\b/i.test(t) ||
					(t.split(/\s+/).length >= 2 && /^[A-Z]/.test(t) && /[A-Z][a-z]+\s+[A-Z]/.test(t))
				) {
					return " ";
				}
				// Truncated paren from bad parse: "Sex Pistols (Steve Jones"
				return full;
			},
		)
		.replace(/\s+/g, " ")
		.trim();

	// Unclosed paren leftover: "Sex Pistols (Steve Jones"
	const unclosed = stripped.match(/^(.+?)\s*\([A-Z][^)]*$/);
	if (unclosed && unclosed[1]!.trim().length >= 3) {
		return unclosed[1]!.trim();
	}
	return stripped;
}

/** Strip lineup noise for catalog matching — "Bob Schneider Trio" → "bob schneider". */
export function normalizeBandNameForMatch(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.replace(/\s+trio$/i, "")
		.replace(/\s+band$/i, "")
		.replace(/\s+&\s+friends$/i, "")
		.replace(/\s+and\s+friends$/i, "")
		.trim();
}

function stripVenueBranding(title: string): string {
	let next = title;
	for (const prefix of VENUE_BRANDING_PREFIXES) {
		const stripped = next.replace(prefix, "");
		if (stripped !== next) {
			next = stripped;
			break;
		}
	}
	return next;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip venue name stuck on calendar titles:
 *   "Bob Schneider - Buck's Backyard" → "Bob Schneider"
 *   "Artist at Mohawk" → "Artist"
 * Never keep venue as part of the artist catalog name.
 */
export function stripVenueNameFromTitle(title: string, venueName?: string | null): string {
	let next = title.trim();
	if (!next) return next;

	const candidates = new Set<string>();
	const v = (venueName || "").trim();
	if (v.length >= 2) {
		candidates.add(v);
		// Possessive / branding variants
		candidates.add(v.replace(/['\u2019]s\b/gi, ""));
		candidates.add(v.replace(/\s+ampitheatre$/i, "").replace(/\s+amphitheater$/i, ""));
	}

	for (const name of candidates) {
		const n = name.trim();
		if (n.length < 2) continue;
		const esc = escapeRegExp(n).replace(/\s+/g, "\\s+");
		// "Artist - Venue" / "Artist – Venue" / "Artist | Venue"
		const dashVenue = new RegExp(`\\s*[-–—|]\\s*(?:the\\s+)?${esc}\\s*$`, "i");
		const strippedDash = next.replace(dashVenue, "").trim();
		if (strippedDash.length >= 2 && strippedDash !== next) {
			next = strippedDash;
			continue;
		}
		// "Artist at Venue" / "Artist @ Venue"
		const atVenue = new RegExp(`\\s+(?:at|@)\\s+(?:the\\s+)?${esc}\\s*$`, "i");
		const strippedAt = next.replace(atVenue, "").trim();
		if (strippedAt.length >= 2 && strippedAt !== next) {
			next = strippedAt;
		}
	}

	// Generic: trailing " - Some Venue Backyard/Amphitheater/…" when no venueName passed
	// (only safe venue-ish tails — not " - The Farewell Tour" which stripTourSubtitle handles)
	if (!v) {
		const genericVenueTail =
			/\s*[-–—|]\s*(?:the\s+)?[^-–—|]{2,60}(?:\s+backyard|\s+amphitheatre|\s+amphitheater|\s+music\s+hall|\s+ballroom|\s+pavilion|\s+opera\s+house|\s+theatre|\s+theater|\s+lounge|\s+tavern|\s+saloon)\s*$/i;
		const g = next.replace(genericVenueTail, "").trim();
		if (g.length >= 2) next = g;
	}

	return next;
}

function stripStatusPrefixes(title: string): string {
	let next = title;
	for (const prefix of STATUS_PREFIXES) {
		const stripped = next.replace(prefix, "");
		if (stripped === next) break;
		next = stripped;
	}
	return next;
}

export function isEventSeriesName(name: string): boolean {
	const n = name.trim().toLowerCase().replace(/\s+/g, " ");
	if (!n) return false;
	if (EVENT_SERIES_NAMES.has(n)) return true;
	// Strip "Live Music:" leftovers
	const stripped = n.replace(/^(?:live\s+music|free\s+concert|special\s+event)\s*:\s*/i, "").trim();
	if (EVENT_SERIES_NAMES.has(stripped)) return true;
	return EVENT_SERIES_PATTERNS.some((re) => re.test(n) || re.test(stripped));
}

function stripTourSubtitle(title: string): string {
	const dashTour = title.match(/^(.+?)\s*[-–—]\s*(?:The\s+)?[^-–—]+?\s+Tour\b/i);
	if (dashTour && dashTour[1]!.length >= 3) return dashTour[1]!.trim();

	// "Black Veil Brides: Vindicatour US 2026" — tour name after colon (*tour* may be glued)
	const colonTour = title.match(
		/^([^:]+):\s*(?:The\s+)?[^:]*(?:\bTour\b|tour\b)[^:]*$/i,
	);
	if (colonTour && colonTour[1]!.trim().length >= 2) return colonTour[1]!.trim();

	// "Artist: World Tour 2026" / "Artist - Summer Tour"
	const dashYearTour = title.match(
		/^(.+?)\s*[-–—]\s*(?:The\s+)?[^-–—]*\b(?:Tour|Vindicatour)\b[^-–—]*$/i,
	);
	if (dashYearTour && dashYearTour[1]!.trim().length >= 2) return dashYearTour[1]!.trim();

	return title;
}

function stripAlbumReleaseLabel(title: string): string {
	const match = title.match(/^(.+?)\s+Album\s+Release(?:\s+Show)?(?:\s|$)/i);
	return match && match[1].length >= 2 ? match[1].trim() : title;
}

function stripTributePrefix(title: string): string {
	const match = title.match(/^(.+\s+Tribute)\s*:\s*(.+)$/i);
	return match ? match[2].trim() : title;
}

function takeHeadlinerFromBill(title: string): string {
	if (!/,/.test(title) && !/\s&\s+More$/i.test(title)) return title;
	const first = title.match(/^([^,]+)/);
	return first ? first[1].trim() : title;
}

function splitOnOpeners(title: string): string | null {
	// Allow "w/TheBand" (no space after slash) — common on venue calendars
	const match = title.match(/^(.+?)\s+(?:w\/\s*|with\s+)(.+)$/i);
	if (!match) return null;

	let head = match[1].trim();
	const openers = match[2].trim();
	if (isEventSeriesName(head)) {
		const primaryOpener = openers.split(/\s*(?:,|&|\+)\s*/)[0]?.trim();
		return primaryOpener && primaryOpener.length >= 2 ? primaryOpener : openers;
	}

	if (head.includes(":")) {
		const billed = head.match(/^([^:]+):/);
		if (billed?.[1]?.trim()) head = billed[1].trim();
	}

	return head.length >= 2 ? head : null;
}

/**
 * Pulls a band/artist name from noisy venue calendar titles.
 * "Live Music: Sentimental Family Band" → "Sentimental Family Band"
 * "Bob Schneider - Buck's Backyard" → "Bob Schneider" (pass venueName)
 */
/** Decode HTML entities before band parse (EventON JSON-LD: &amp; / &#039;). */
function decodeHtmlEntitiesLocal(text: string): string {
	let s = String(text ?? "");
	for (let i = 0; i < 3; i++) {
		const next = s
			.replace(/&amp;/gi, "&")
			.replace(/&#0*39;|&apos;/gi, "'")
			.replace(/&#8217;|&rsquo;/gi, "'")
			.replace(/&#8216;|&lsquo;/gi, "'")
			.replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
			.replace(/&quot;/gi, '"')
			.replace(/&nbsp;/gi, " ")
			.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
			.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
		if (next === s) break;
		s = next;
	}
	return s.replace(/\s+/g, " ").trim();
}

export function extractBandName(rawTitle: string, venueName?: string | null): string {
	let title = decodeHtmlEntitiesLocal(rawTitle)
		.replace(/^[[({]\s*/, "")
		.replace(/\s*[\])}]$/, "")
		.replace(/\.+$/, "")
		.trim();

	title = stripStatusPrefixes(title);
	title = stripVenueBranding(title);
	// Venue suffix early so tour/feat logic runs on the act only
	title = stripVenueNameFromTitle(title, venueName);
	title = stripTributePrefix(title);
	title = stripTourSubtitle(title);
	title = stripAlbumReleaseLabel(title);
	title = title.replace(NOISE_PARENTHETICALS, " ").replace(/\s+/g, " ").trim();
	title = stripLineupParentheticals(title);

	for (const prefix of TITLE_PREFIXES) {
		title = title.replace(prefix, "");
	}
	for (const suffix of TITLE_SUFFIXES) {
		title = title.replace(suffix, "");
	}

	// Again after prefix/suffix cleanup (some calendars leave "Act Live - Venue")
	title = stripVenueNameFromTitle(title, venueName);

	const eveningWith = title.match(/^an?\s+evening\s+with\s+(.+)$/i);
	if (eveningWith) return takeHeadlinerFromBill(eveningWith[1].trim());

	const featSplit = title.match(/^(.+?)\s+(?:feat\.?|featuring|ft\.?)\s+.+$/i);
	if (featSplit && featSplit[1].length >= 3) return takeHeadlinerFromBill(featSplit[1].trim());

	const withSplit = splitOnOpeners(title);
	if (withSplit) return takeHeadlinerFromBill(withSplit);

	const presents = title.match(/presents?\s*:?\s*(.+)$/i);
	if (presents && presents[1].length >= 3 && presents[1].length < title.length) {
		return takeHeadlinerFromBill(presents[1].trim());
	}

	const andFriends = title.match(/^(.+?)\s+(?:&|and)\s+friends$/i);
	if (andFriends && andFriends[1].length >= 3) return andFriends[1].trim();

	return takeHeadlinerFromBill(title.trim());
}

/** Regression fixtures for Antone's-style calendar titles. */
export const PARSE_BAND_NAME_FIXTURES: Array<{ input: string; expected: string }> = [
	{
		input: "SOLD OUT – Antone's 51st Anniversary: Gary Clark Jr. feat. Ivan Neville w/ The Point.",
		expected: "Gary Clark Jr.",
	},
	{
		input: "Antone’s 51st Anniversary: Bun B w/ Killa Kyleon, B.Banks, BP Oil Spill, J Soulja, Clova Yoda & DJ Napalm",
		expected: "Bun B",
	},
	{ input: "Antone's 51st Anniversary: Soulhat w/ The Moeller Brothers", expected: "Soulhat" },
	{ input: "Adobro Album Release Show", expected: "Adobro" },
	{
		input: "Antone's 51st Anniversary: Blue Monday w/ Soul Man Sam & Lindsay Beaver",
		expected: "Soul Man Sam",
	},
	{
		input: "Antone's 51st Anniversary: Matt \"Guitar\" Murphy Tribute: Bobby Christina's Blues Caravan ft. Floyd Murphy Jr., Fran Christina & More + Darrell Nulisch, Duke Robillard & Anson Funderburgh",
		expected: "Bobby Christina's Blues Caravan",
	},
	{
		input: "Antone's 51st Anniversary: Lurrie Bell, Darrell Nulisch, Duke Robillard, Anson Funderburgh & More",
		expected: "Lurrie Bell",
	},
	{
		input: "Antone's 51st Anniversary: Ruben Ramos Album Release ft. Carrie Rodriguez & Friends + Los Texmaniacs",
		expected: "Ruben Ramos",
	},
	{ input: "Sincere Engineer - The Probable Claws Tour w/ Sulynn Hago & Smug LLC", expected: "Sincere Engineer" },
	{ input: "DWLLRS: One of Those Nights Tour w/ thebandfriday", expected: "DWLLRS" },
	{
		input: "Antone's 51st Anniversary: Bob Schneider (FULL BAND) w/ John Primer",
		expected: "Bob Schneider",
	},
	{ input: "Blue Monday w/ Soul Man Sam & Lindsay Beaver", expected: "Soul Man Sam" },
	{ input: "Rio Da Yung OG: The World is M.I.N.E. Tour w/ Yung Hood, RoadRun CMoe, J Rich Tha Don & DJ Naplam", expected: "Rio Da Yung OG" },
	{ input: "Meet Me @ The Altar: The Worried Sick Summer Tour w/ Leisure Hour", expected: "Meet Me @ The Altar" },
	// Venue name must never become part of the artist catalog name
	{ input: "Bob Schneider - Buck's Backyard", expected: "Bob Schneider" },
	{ input: "Deep Blue Something - Buck's Backyard", expected: "Deep Blue Something" },
	{ input: "Giovannie & The Hired Guns - Buck's Backyard", expected: "Giovannie & The Hired Guns" },
	{ input: "Desert Highway – Eagles Tribute - Buck's Backyard", expected: "Desert Highway – Eagles Tribute" },
	{ input: "Cole Barnhill at Buck's Backyard", expected: "Cole Barnhill" },
	// Tour / lineup noise must not become the catalog name
	{
		input: "Black Veil Brides: Vindicatour US 2026",
		expected: "Black Veil Brides",
	},
	{
		input: "Sex Pistols (Steve Jones, Paul Cook, Glen Matlock) feat. Frank Carter",
		expected: "Sex Pistols",
	},
	{
		input: "Sex Pistols (Steve Jones",
		expected: "Sex Pistols",
	},
];

/** Fixtures that need the venue name argument (suffix match). */
export const PARSE_BAND_NAME_VENUE_FIXTURES: Array<{
	input: string;
	venueName: string;
	expected: string;
}> = [
	{ input: "Bob Schneider - Buck's Backyard", venueName: "Buck's Backyard", expected: "Bob Schneider" },
	{ input: "Bag of Donuts - Buck's Backyard", venueName: "Buck's Backyard", expected: "Bag of Donuts" },
	{ input: "Someone Cool at Mohawk", venueName: "Mohawk", expected: "Someone Cool" },
];