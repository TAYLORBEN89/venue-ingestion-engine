/**
 * Multi-artist lineup parsing for enrichment.
 * Does NOT change public event titles — only extracts names for catalog matching
 * and event_artists linking.
 *
 * Separator tiers (important):
 *  - w/ / support "with"  → different act(s) after main bill (not part of headliner name)
 *  - feat. / ft. / featuring → special guests
 *  - " + " → co-bill / multi-headliner (festival style)
 *  - & / and → CO-BILL only when not a single-act band name / backing-band form
 *  - presents: / Live Music: → packaging (stripped via extractBandName / local strip)
 *
 * Headliner = first real slot (billing_order 0). Only headliner should populate
 * event hero media / primary show fill. All slots still get About + profile link.
 */

import { extractBandName, isEventSeriesName } from "./parse-band-name";

export type LineupRole =
	| "headliner"
	| "support"
	| "opener"
	| "special_guest"
	| "host"
	| "tribute";

export interface LineupSlot {
	name: string;
	role: LineupRole;
	billing_order: number;
}

/** Non-artist noise that should not become catalog matches. */
const NOISE_NAMES =
	/^(special\s+guests?|guests?|more|friends|full\s+band|tba|tbd|dj\s+set|doors|openers?|and\s+more|&\s+more)$/i;

/**
 * Right-hand side of "X & The Y" that is almost always a *backing band*,
 * not a second headliner. Deliberately excludes independent acts like
 * "The Weary Boys", "The Doobie Brothers".
 */
const BACKING_BAND_RHS =
	/^(?:the\s+)?(?:flat five|bangas|hired guns|dark clouds|boxmasters|violators|tones|ramblers|bandits|fury|big time|selfless lovers|morning afters|gueyfarers|honky-?tonk doctors|lonesome|resophonics|audacity|north americans|prickly pears|poor bastards|station masters|tight five|spurflowers|regulars|loveless|high top fades|artifacts|b-?team|lone stars|small large band|large band|banned for life|boys)$/i;

/**
 * Full act names that contain &/and but are ONE catalog artist.
 * Checked before co-bill splitting.
 */
const KNOWN_SINGLE_ACT_WITH_AND: RegExp[] = [
	/^tank and the bangas$/i,
	/^tank & the bangas$/i,
	/^the war and treaty$/i,
	/^the wind & the wave$/i,
	/^the wind and the wave$/i,
	/^sarah and the sundays$/i,
	/^tome and the tones$/i,
	/^giovannie & the hired guns$/i,
	/^giovannie and the hired guns$/i,
	/^billy bob thornton & the boxmasters$/i,
	/^billy bob thornton and the boxmasters$/i,
	/^alison krauss & union station$/i,
	/^alison krauss and union station$/i,
	/^adam & chris carroll$/i,
	/^adam and chris carroll$/i,
	/^dana and alden$/i,
	/^dan and phil$/i,
	/^earth,?\s*wind & fire$/i,
	/^earth,?\s*wind and fire$/i,
	/^link & chain$/i,
	/^link and chain$/i,
	/^brooks & dunn$/i,
	/^hall & oates$/i,
	/^simon and garfunkel$/i,
	/^simon & garfunkel$/i,
	/^belle and sebastian$/i,
	/^mumford & sons$/i,
	/^mumford and sons$/i,
	/^of monsters and men$/i,
	/^florence (?:&|and) the machine$/i,
	/^nick cave (?:&|and) the bad seeds$/i,
	/^elvis costello (?:&|and) the (?:attractions|imposters)$/i,
	/^siouxsie (?:&|and) the banshees$/i,
	/^ike (?:&|and) tina turner$/i,
	/^derek (?:&|and) the dominos$/i,
	/^booker t\.?\s*(?:&|and)\s*the mg'?s$/i,
	/^crosby,?\s*stills (?:&|and) nash$/i,
	/^peter,?\s*paul (?:&|and) mary$/i,
	/^sly (?:&|and) the family stone$/i,
	/^kc (?:&|and) the sunshine band$/i,
	/^blood,? sweat (?:&|and) tears$/i,
];

function cleanName(name: string): string {
	return name
		.replace(/\s*\([^)]*\)\s*/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^[,+&|]+|[,+&|]+$/g, "")
		.replace(/\s*[!?.]+$/g, "")
		.trim();
}

function isNoise(name: string): boolean {
	const n = cleanName(name);
	if (n.length < 2) return true;
	if (NOISE_NAMES.test(n)) return true;
	if (/^\d{4}-\d{2}-\d{2}/.test(n)) return true;
	if (/hours of operation|karaoke|trivia|open mic|watch party|world cup/i.test(n)) return true;
	if (/^live at\b/i.test(n)) return true;
	return false;
}

function isKnownSingleActWithAnd(name: string): boolean {
	const n = cleanName(name);
	return KNOWN_SINGLE_ACT_WITH_AND.some((re) => re.test(n));
}

function isBackingBandRhs(name: string): boolean {
	const n = cleanName(name);
	if (/^(his|her|their)\s+/i.test(n)) return true;
	if (/^friends$/i.test(n)) return true;
	return BACKING_BAND_RHS.test(n);
}

/** Find support bill after w/ or with, excluding "evening/night with" phrasing. */
function findOpenerClause(title: string): { main: string; openers: string } | null {
	// w/ is unambiguous (allow w/The with no space after slash)
	const slash = title.match(/^(.*?)\s+w\/\s*(.+)$/i);
	if (slash) {
		return { main: slash[1].trim(), openers: slash[2].trim() };
	}

	const withRe = /\s+with\s+/gi;
	let match: RegExpExecArray | null;
	while ((match = withRe.exec(title)) !== null) {
		const before = title.slice(0, match.index);
		const beforeLow = before.toLowerCase();
		// Skip "an evening with", "a night with", tour "with" mid-phrase after Tour
		if (/\b(an?\s+)?(evening|night|afternoon|morning|session)\s*$/i.test(beforeLow)) {
			continue;
		}
		// "Burning Floor Tour with Descartes..." — openers after Tour with
		// Keep main as extractBandName of whole title; openers = after with
		return {
			main: before.trim(),
			openers: title.slice(match.index + match[0].length).trim(),
		};
	}
	return null;
}

/**
 * Split a main-bill string into co-headliner names.
 * Conservative: prefers keeping single-act band names intact.
 */
export function splitCoHeadliners(mainBill: string): string[] {
	let bill = cleanName(mainBill);
	if (!bill) return [];

	// Drop trailing "Live at Venue!"
	bill = bill.replace(/\s+live\s+at\s+.+$/i, "").trim();

	if (isKnownSingleActWithAnd(bill)) return [bill];

	// "X & Friends" / "X and Friends" → just X
	const friends = bill.match(/^(.+?)\s+(?:&|and)\s+friends$/i);
	if (friends?.[1]) return [cleanName(friends[1])];

	// Festival-style +
	if (/\s\+\s/.test(bill)) {
		const parts = bill
			.split(/\s*\+\s*/)
			.map(cleanName)
			.filter((p) => p && !isNoise(p) && !/special\s+guests?/i.test(p));
		if (parts.length >= 2) return parts;
	}

	// Co-bill on & / and
	if (/\s+(?:&|and)\s+/i.test(bill)) {
		// Event/phrase titles that are not co-bills
		if (
			/^(with love|to have and to hold|arts?\s*&\s*crafts?|pickin['']?\s*&\s*sippin|cocktails\s+and\s+comedy|sip\s*&\s*sculpt)/i.test(
				bill,
			)
		) {
			return [bill];
		}

		// Prefer splitting on " & " then " and "
		const parts = bill
			.split(/\s+&\s+|\s+and\s+/i)
			.map(cleanName)
			.filter(Boolean);

		if (parts.length >= 2) {
			const real = parts.filter((p) => !isNoise(p));
			if (real.length < 2) return [bill];
			// Two-part: keep whole if RHS is backing band of a frontperson act
			if (real.length === 2 && isBackingBandRhs(real[1])) {
				return [bill];
			}
			// If every part after first is backing, keep whole
			if (real.slice(1).every(isBackingBandRhs)) return [bill];
			// Two single-token abstract words (e.g. "Fear and Loathing") — keep whole
			if (
				real.length === 2 &&
				!/\s/.test(real[0]) &&
				!/\s/.test(real[1]) &&
				real[0].length <= 10 &&
				real[1].length <= 12 &&
				!/^[A-Z0-9]{2,}$/.test(real[0]) // allow "311" style? 311 is digits
			) {
				// Still split known short co-bills like "Styx & Chicago" (both multi-letter brands)
				// Styx and Chicago are proper names — allow split if both Capitalized single tokens of length >= 4
				const bothProper =
					/^[A-Z][a-z]/.test(real[0]) &&
					/^[A-Z][a-zA-Z]/.test(real[1]) &&
					real[0].length >= 3 &&
					real[1].length >= 4;
				if (!bothProper && !/^\d+$/.test(real[1])) {
					// "Daphnis & Gloria" is a real duo — both proper → split via bothProper
					// "Love and Gratitude" lower-case middle — already cleaned, may lose case
				}
			}
			return real;
		}
	}

	// Comma bills: "A, B, C & More" → first is headliner; include others if not More
	if (/,/.test(bill)) {
		const parts = bill
			.split(/\s*,\s*/)
			.map((p) => p.replace(/\s+(?:&|and)\s+more$/i, "").trim())
			.map(cleanName)
			.filter((p) => p && !isNoise(p) && !/^more$/i.test(p));
		// Only expand multi-comma when 2+ real names (not "Last, First" false positives —
		// require each part to look like an act: 2+ chars, preferably multi-token or known)
		if (parts.length >= 2 && parts.every((p) => p.length >= 2)) {
			// Avoid splitting "Murphy, Texas" style — if any part is a single short place-like token skip
			const lookLikeActs = parts.filter((p) => /\s/.test(p) || p.length >= 4);
			if (lookLikeActs.length >= 2) return lookLikeActs;
		}
	}

	return [bill];
}

function stripPackagingPrefix(title: string): string {
	let t = title.trim();
	t = t.replace(
		/^(?:SOLD\s+OUT|CANCELLED|CANCELED|POSTPONED|RESCHEDULED|NEW\s+DATE)\s*[-–—:]\s*/i,
		"",
	);
	t = t.replace(/^(?:free\s+concert|live\s+music|live|concert|music|show|special\s+event)\s*:\s*/i, "");
	// "Under The Rock Presents: ARTISTS"
	t = t.replace(/^[^:]{0,60}\bpresents?\s*:\s*/i, "");
	// Levitation / series prefix keep rest for + split
	return t.trim();
}

/**
 * Split a billing string into ordered artist slots.
 */
export function parseLineupFromTitle(rawTitle: string): LineupSlot[] {
	const slots: LineupSlot[] = [];
	const seen = new Set<string>();

	const push = (name: string, role: LineupRole) => {
		const cleaned = cleanName(name);
		if (isNoise(cleaned)) return;
		// Drop leftover packaging crumbs
		if (/^(live music|free concert|special event)$/i.test(cleaned)) return;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		slots.push({ name: cleaned, role, billing_order: slots.length });
	};

	let working = stripPackagingPrefix(String(rawTitle || ""));
	if (!working) return slots;

	// Pull feat. guests first (from full string)
	let featTail: string | null = null;
	const featMatch = working.match(/^(.*?)\s+(?:feat\.?|featuring|ft\.?)\s+(.+)$/i);
	if (featMatch) {
		working = featMatch[1].trim();
		featTail = featMatch[2].trim();
		// feat tail may still contain w/ — rare; strip for guests
		featTail = featTail.replace(/\s+w\/\s+.+$/i, "").trim();
	}

	// Openers after w/ / with
	const opener = findOpenerClause(working);
	let mainBill = working;
	let openersTail: string | null = null;
	if (opener) {
		mainBill = opener.main;
		openersTail = opener.openers;
	}

	// Strip tour subtitles from main for cleaner names
	// "Sincere Engineer - The Probable Claws Tour" → Sincere Engineer
	const dashTour = mainBill.match(/^(.+?)\s*[-–—]\s*(?:The\s+)?[^-–—]+?\s+Tour\b/i);
	if (dashTour?.[1] && dashTour[1].length >= 3) {
		mainBill = dashTour[1].trim();
	}
	// "Chelsea Handler: The High and Mighty Tour" → Chelsea Handler
	// (must run BEFORE co-bill split or "and" inside tour titles false-splits)
	const colonTour = mainBill.match(
		/^([^:]{2,50})\s*:\s*(?:The\s+)?[^:]{0,60}\s+Tour\b/i,
	);
	if (colonTour?.[1] && colonTour[1].length >= 2) {
		mainBill = colonTour[1].trim();
	}
	// "Tank and The Bangas: The Last Balloon Tour" → keep left (known single or co-bill left)
	const colonAlbum = mainBill.match(/^(.+?)\s*:\s+(.+)$/);
	if (
		colonAlbum &&
		/\b(tour|album|live|night|show)\b/i.test(colonAlbum[2]) &&
		colonAlbum[1].length >= 3 &&
		colonAlbum[1].length < 60
	) {
		mainBill = colonAlbum[1].trim();
	}

	// Use extractBandName as a final cleaner for single-headliner edge cases,
	// but prefer our mainBill when it still has multi-act separators we care about.
	const hasMulti =
		/\s\+\s/.test(mainBill) ||
		/\s+&\s+/.test(mainBill) ||
		/\s+and\s+/i.test(mainBill) ||
		/,/.test(mainBill);

	// Series / event-format label before w/ (Gospel Brunch, Blue Monday, Sing Along Saturdays…)
	// → NOT an artist. Real acts are only after w/.
	const mainIsSeries = isEventSeriesName(mainBill);

	let headNames: string[];
	if (mainIsSeries && openersTail) {
		// No headliner from series name; openers become the bill (first = headliner)
		headNames = [];
	} else if (hasMulti) {
		// Also strip "Levitation 2026:" style if still present
		const afterColon = mainBill.includes(":")
			? mainBill.slice(mainBill.lastIndexOf(":") + 1).trim()
			: mainBill;
		headNames = splitCoHeadliners(afterColon);
	} else if (opener) {
		// Main bill already isolated before w/ — do not re-run extractBandName on full title
		// (extractBandName historically required a space after w/ and can miss w/The)
		const extractedMain = extractBandName(mainBill);
		headNames = [extractedMain || mainBill];
	} else {
		const extracted = extractBandName(rawTitle);
		// Don't promote pure series titles with no w/ act as artists
		if (extracted && isEventSeriesName(extracted) && !openersTail) {
			headNames = [];
		} else {
			headNames = extracted ? [extracted] : [mainBill];
		}
	}

	// Fallback if split emptied (and not a bare series title)
	if (!headNames.length && !(mainIsSeries && openersTail)) {
		const extracted = extractBandName(rawTitle);
		if (extracted && !isEventSeriesName(extracted)) headNames = [extracted];
	}

	headNames.forEach((name, i) => {
		if (isEventSeriesName(name)) return; // never catalog a series label as headliner
		push(name, i === 0 ? "headliner" : "support");
	});

	// Openers / support after w/
	if (openersTail) {
		const tail = openersTail
			.replace(/\s*[-–—].*$/, "") // drop trailing tour noise
			.replace(/\s+live\s+at\s+.+$/i, "")
			.trim();
		const special = tail.match(/^special\s+guests?\s+(.+)$/i);
		if (special) {
			for (const part of special[1].split(/\s*(?:,|&|\+)\s*/)) {
				push(part, "special_guest");
			}
		} else if (!/^special\s+guests?$/i.test(tail)) {
			const parts = tail.split(/\s*(?:,|&|\+)\s*/).filter(Boolean);
			parts.forEach((part, i) => {
				if (isNoise(part)) return;
				if (mainIsSeries) {
					// Series w/ Act — first act is the headliner for the event
					push(part, i === 0 && slots.length === 0 ? "headliner" : i === 0 ? "support" : "opener");
				} else {
					// First after w/ → support; rest → opener
					push(part, i === 0 ? "support" : "opener");
				}
			});
		}
	}

	// Feat guests
	if (featTail) {
		const guestBits = featTail
			.replace(/\s+live\s+at\s+.+$/i, "")
			.split(/\s*(?:,|&|\+)\s*/);
		for (const part of guestBits) {
			// "Nate Evans" from "Featuring Nate Evans"
			const cleaned = part.replace(/^featuring\s+/i, "").trim();
			// "from The Band of Heathens" is not a separate act — keep "Ed Jurdi from..."
			// as one name if it was already a co-bill part; here feat guests are simple
			if (/^from\s+/i.test(cleaned)) continue;
			push(cleaned, "special_guest");
		}
	}

	// Re-number billing_order
	slots.forEach((s, i) => {
		s.billing_order = i;
	});

	return slots;
}

/** Regression fixtures for multi-artist titles. */
export const PARSE_LINEUP_FIXTURES: Array<{
	input: string;
	expectedNames: string[];
	headliner: string;
}> = [
	{
		input: "Silverada & The Weary Boys w/ The Wyatt Weaver Band",
		expectedNames: ["Silverada", "The Weary Boys", "The Wyatt Weaver Band"],
		headliner: "Silverada",
	},
	{
		input: "Knocked Loose & Denzel Curry",
		expectedNames: ["Knocked Loose", "Denzel Curry"],
		headliner: "Knocked Loose",
	},
	{
		input: "Tank and The Bangas",
		expectedNames: ["Tank and The Bangas"],
		headliner: "Tank and The Bangas",
	},
	{
		input: "The Wind & The Wave",
		expectedNames: ["The Wind & The Wave"],
		headliner: "The Wind & The Wave",
	},
	{
		input: "Live Music: Levitation 2026: AMERICAN FOOTBALL + TANUKICHAN + NINE PERFECT LIVES",
		expectedNames: ["AMERICAN FOOTBALL", "TANUKICHAN", "NINE PERFECT LIVES"],
		headliner: "AMERICAN FOOTBALL",
	},
	{
		input: "Under The Rock Presents:AMANDA PASCALI & GINA CHAVEZ",
		expectedNames: ["AMANDA PASCALI", "GINA CHAVEZ"],
		headliner: "AMANDA PASCALI",
	},
	{
		input: "Alison Krauss & Union Station featuring Jerry Douglas",
		expectedNames: ["Alison Krauss & Union Station", "Jerry Douglas"],
		headliner: "Alison Krauss & Union Station",
	},
	{
		input: "Ricky Stein ft Alex Saxon Live at The Cactus Cafe!",
		expectedNames: ["Ricky Stein", "Alex Saxon"],
		headliner: "Ricky Stein",
	},
	{
		input: "Chanel Beads w/ Mechatok, & Car Culture",
		expectedNames: ["Chanel Beads", "Mechatok", "Car Culture"],
		headliner: "Chanel Beads",
	},
	{
		input: "King Daddy & the Flat Five",
		expectedNames: ["King Daddy & the Flat Five"],
		headliner: "King Daddy & the Flat Five",
	},
	{
		input: "Styx & Chicago",
		expectedNames: ["Styx", "Chicago"],
		headliner: "Styx",
	},
	{
		input: "Ziggy Marley and Gov't Mule",
		expectedNames: ["Ziggy Marley", "Gov't Mule"],
		headliner: "Ziggy Marley",
	},
	{
		input: "Franz Ferdinand w/ Sunday Mourners",
		expectedNames: ["Franz Ferdinand", "Sunday Mourners"],
		headliner: "Franz Ferdinand",
	},
	{
		input: "Ben Schwartz & Friends",
		expectedNames: ["Ben Schwartz"],
		headliner: "Ben Schwartz",
	},
	{
		input: "Nik Parr & The Selfless Lovers",
		expectedNames: ["Nik Parr & The Selfless Lovers"],
		headliner: "Nik Parr & The Selfless Lovers",
	},
	{
		// Series name, not a band — headliner is the act after w/
		input: "Sing Along Saturdays w/The Lonestar Souvenirs",
		expectedNames: ["The Lonestar Souvenirs"],
		headliner: "The Lonestar Souvenirs",
	},
	{
		input: "Live Music: Gospel Brunch w/ The Levites",
		expectedNames: ["The Levites"],
		headliner: "The Levites",
	},
	{
		input: "Gospel Brunch w/ The Moriah Sisters",
		expectedNames: ["The Moriah Sisters"],
		headliner: "The Moriah Sisters",
	},
	{
		input: "Blue Monday w/ Soul Man Sam & Lindsay Beaver",
		expectedNames: ["Soul Man Sam", "Lindsay Beaver"],
		headliner: "Soul Man Sam",
	},
	{
		input: "Kym Warner & Tony Kamel",
		expectedNames: ["Kym Warner", "Tony Kamel"],
		headliner: "Kym Warner",
	},
	{
		input: "Dirty Heads and 311",
		expectedNames: ["Dirty Heads", "311"],
		headliner: "Dirty Heads",
	},
	{
		input: "Link & Chain + Hail Marley!",
		// Link & Chain is one act; + splits co-bill
		expectedNames: ["Link & Chain", "Hail Marley"],
		headliner: "Link & Chain",
	},
	{
		input: "Chelsea Handler: The High and Mighty Tour",
		expectedNames: ["Chelsea Handler"],
		headliner: "Chelsea Handler",
	},
	{
		input: "Live Music: Tank and The Bangas: The Last Balloon Tour w/ Ariel J.",
		expectedNames: ["Tank and The Bangas", "Ariel J"],
		headliner: "Tank and The Bangas",
	},
];
