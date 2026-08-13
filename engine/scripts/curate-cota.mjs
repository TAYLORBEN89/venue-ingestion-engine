/**
 * Thorough curation for Circuit of The Americas pending rows:
 * - Real descriptions (not video-fallback noise)
 * - Ends_at for multi-day motorsport
 * - Better gate times
 * - Categories / genres / SEO / event_intro
 * - Full image URLs
 *
 *   node scripts/curate-cota.mjs
 *   node scripts/curate-cota.mjs --approve   # after curate, bulk-approve
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SLUG = "circuit-of-the-americas";
const TZ = "America/Chicago";
const doApprove = process.argv.includes("--approve");

const env = Object.fromEntries(
	readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
		.split(/\r?\n/)
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

function strip(s) {
	return String(s || "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#8211;|&#8212;/g, "–")
		.replace(/&#038;/g, "&")
		.replace(/&#0?39;|&apos;/gi, "'")
		.replace(/&#8217;|&#8216;/g, "'")
		.replace(/&#8220;|&#8221;/g, '"')
		.replace(/&quot;/gi, '"')
		.replace(/\s+/g, " ")
		.trim();
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

function getOffsetMin(timeZone, at) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		})
			.formatToParts(at)
			.filter((p) => p.type !== "literal")
			.map((p) => [p.type, p.value]),
	);
	let hour = Number(parts.hour);
	if (hour === 24) hour = 0;
	return (
		(Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second) -
			at.getTime()) /
		60000
	);
}

function localToUtc(ymd, clock) {
	const [y, m, d] = ymd.split("-").map(Number);
	const [hh, mm, ss = 0] = clock.split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, +ss));
	return new Date(guess.getTime() - getOffsetMin(TZ, guess) * 60000).toISOString();
}

function parseEndYmd(rawDate, startYmd) {
	// "September 4-6, 2026" → 2026-09-06
	const m = rawDate.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s+(\d{4})/i,
	);
	if (!m) return null;
	const months = {
		january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
		july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
	};
	const mon = months[m[1].toLowerCase()];
	if (!mon) return null;
	return `${m[4]}-${pad2(mon)}-${pad2(+m[3])}`;
}

function truncate(text, maxLen) {
	if (text.length <= maxLen) return text;
	const cut = text.slice(0, maxLen - 1);
	const lastSpace = cut.lastIndexOf(" ");
	return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxLen - 1)}…`;
}

function classify(title, tag = "") {
	const hay = `${title} ${tag}`.toLowerCase();
	if (
		/f1|formula|motogp|nascar|motoamerica|endurance|le mans|8 hour|superbike|wec|racing|motorsport/i.test(
			hay,
		)
	) {
		return {
			// trackside / outdoor sports-event feel
			category_slug: "outdoors",
			genres: ["Motorsports", "Racing"],
			schema_type: "SportsEvent",
			kind: "motorsport",
		};
	}
	if (/bike night/i.test(hay)) {
		return {
			category_slug: "outdoors",
			genres: ["Community", "Cycling"],
			schema_type: "SocialEvent",
			kind: "bike-night",
		};
	}
	if (/cars\s*&\s*coffee|cars and coffee/i.test(hay)) {
		return {
			category_slug: "outdoors",
			genres: ["Community", "Cars & Coffee"],
			schema_type: "SocialEvent",
			kind: "cars-coffee",
		};
	}
	return {
		category_slug: "festivals",
		genres: ["Events"],
		schema_type: "Event",
		kind: "other",
	};
}

const CURATED_COPY = {
	"fia-world-endurance-championship": {
		event_intro:
			"Lone Star Le Mans returns to Circuit of The Americas — FIA World Endurance Championship prototype and GT racing under the lights and Texas sun.",
		description: `The FIA World Endurance Championship brings world-class sports-car racing to Circuit of The Americas for the Lone Star Le Mans weekend. Expect Hypercar and GT machinery, multi-hour races, and a full fan village on the COTA grounds in southeast Austin.

Gates and on-track sessions span the multi-day schedule; check Ticketmaster for day tickets, weekend packages, and hospitality options. COTA’s 3.4-mile Formula 1–grade circuit is the stage — bring ear protection, plan parking early, and use official shuttles when available.

Pair race day with nearby east Austin and downtown stays; mid-day heat is real in early September. Official tickets and upgrades are sold through Ticketmaster’s Lone Star Le Mans inventory.`,
		clock_start: "09:00:00",
		clock_end: "18:00:00",
	},
	f1: {
		event_intro:
			"Formula 1 returns to Austin for the United States Grand Prix at Circuit of The Americas — three days of practice, qualifying, and race day on the only F1 track in the U.S.",
		description: `The Formula 1 United States Grand Prix transforms Circuit of The Americas into a global motorsport capital. Watch free practice, sprint/qualifying formats as scheduled, and the main Grand Prix around COTA’s 20-turn layout with the famous Turn 1 climb.

Expect large crowds, multi-day ticket options, RV and paddock hospitality, and a full festival atmosphere across the grounds. Buy only through official Ticketmaster / COTA channels. Arrive early for traffic, use designated parking and rideshare zones, and plan lodging well in advance — USGP weekends sell out rooms across Austin.

This is COTA’s marquee annual weekend: world championship cars, fan zones, and the full Circuit experience.`,
		clock_start: "09:00:00",
		clock_end: "18:00:00",
	},
	motoamericasuperbikes: {
		event_intro:
			"MotoAmerica Superbikes brings 190 mph road racing and family-friendly paddock energy to Circuit of The Americas.",
		description: `MotoAmerica Superbikes returns to Circuit of The Americas with multiple classes of professional motorcycle road racing. Fans get close-up access to the paddock culture, on-track battles, and a full race weekend schedule across COTA’s championship circuit.

Multi-day tickets and single-day options are typically available through COTA’s Ticketmaster portal. Bring ear protection, sunscreen, and plan for Texas weather. Superbike weekends are a staple of COTA’s motorsports calendar alongside F1, MotoGP, and endurance racing.`,
		clock_start: "09:00:00",
		clock_end: "18:00:00",
	},
	"texas-8-hour": {
		event_intro:
			"The Texas 8 Hour endurance motorcycle race hits Circuit of The Americas — eight hours of team racing under the Texas sky.",
		description: `The Texas 8 Hour is a flagship endurance motorcycle event at Circuit of The Americas, with teams racing for eight continuous hours on the full Grand Prix circuit. Expect paddock access, multi-class grids, and a full race-weekend schedule leading into the main event.

Tickets are sold via Tixr / SRO Motorsports. Plan for a long day trackside — hydration, ear protection, and early arrival recommended. This is a must-see for fans of endurance racing and MotoAmerica-adjacent series action in Austin.`,
		clock_start: "09:00:00",
		clock_end: "20:00:00",
	},
};

const BIKE_NIGHT = {
	event_intro:
		"COTA Bike Night — ride in, hang out, and enjoy an evening community event at Circuit of The Americas.",
	description: `Bike Night at Circuit of The Americas is a community motorcycle meetup on the COTA grounds. Riders roll in for an evening of bikes, food vendors, and trackside atmosphere — a casual night rather than a race weekend.

Registration and tickets (when required) are handled via BikeReg. Check the specific event listing for gate times, parking, and whether the evening includes track-adjacent activities. Arrive early for popular themed nights; follow COTA and BikeReg for weather updates.`,
	clock_start: "17:00:00",
	clock_end: "21:00:00",
};

const CARS_COFFEE = {
	event_intro:
		"Cars & Coffee Austin at Circuit of The Americas — morning car culture on the Grand Prix grounds.",
	description: `Cars & Coffee Austin brings the car community to Circuit of The Americas for a morning meetup on the iconic track grounds. Expect a wide mix of builds, exotics, classics, and daily drivers — more social show than race.

Tickets are sold via Universe for each date. Gates typically open in the morning; confirm times on the Universe event page. Family-friendly and photo-friendly — arrive early for the best spots and follow organizer rules for parking and display areas.`,
	clock_start: "08:00:00",
	clock_end: "12:00:00",
};

async function scrapeCotaDetail(url) {
	const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
	if (!res.ok) return null;
	const h = await res.text();
	const h1 = strip(h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
	const formula = strip(
		h.match(/class="[^"]*formula-date[^"]*"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i)?.[1] ?? "",
	);
	const ogDesc = h.match(/property="og:description"\s+content="([^"]+)"/i)?.[1];
	const ogImage = h.match(/property="og:image"\s+content="([^"]+)"/i)?.[1];
	const clean = h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
	const paras = [...clean.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((m) => strip(m[1]))
		.filter(
			(t) =>
				t.length > 80 &&
				!/browser doesn|html5 video|cookie|privacy|subscribe|your browser/i.test(t),
		);
	const tm =
		h.match(/href="(https?:\/\/(?:www\.)?ticketmaster\.com\/(?!.*venue\/)[^"]+)"/i)?.[1] ??
		h.match(/href="(https?:\/\/am\.ticketmaster\.com\/cota\/[^"]*)"/i)?.[1] ??
		null;
	return {
		h1,
		formula,
		ogDesc: ogDesc ? strip(ogDesc) : null,
		ogImage,
		paras,
		ticket: tm?.replace(/&amp;/g, "&") ?? null,
	};
}

const { data: venue } = await sb
	.from("venues")
	.select("id, name, site_id, sites(name, city)")
	.eq("slug", SLUG)
	.single();
if (!venue) throw new Error("venue not found");

const { data: categories } = await sb
	.from("categories")
	.select("id, slug, name")
	.eq("site_id", venue.site_id)
	.eq("kind", "event");
const catBySlug = Object.fromEntries((categories ?? []).map((c) => [c.slug, c]));
console.log(
	"event categories:",
	(categories ?? []).map((c) => c.slug).join(", ") || "(none)",
);

const { data: pending, error } = await sb
	.from("ingested_events")
	.select("*")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending")
	.order("parsed_starts_at");
if (error) throw new Error(error.message);

console.log(`\nCurating ${pending?.length ?? 0} pending COTA events…\n`);

for (const row of pending ?? []) {
	const payload = { ...(row.raw_payload ?? {}) };
	const title = row.raw_title;
	const tag = payload.event_tag ?? "";
	const slugKey = row.source_event_id || "";
	const cls = classify(title, tag);

	// Prefer explicit category that exists
	let category_slug = cls.category_slug;
	if (!catBySlug[category_slug]) {
		// fall back order
		for (const s of ["festivals", "outdoors", "live-music", "family"]) {
			if (catBySlug[s]) {
				category_slug = s;
				break;
			}
		}
	}

	let description = payload.description;
	if (!description || /browser doesn|html5 video/i.test(description)) {
		description = null;
	}

	let event_intro = payload.event_intro ?? null;
	let clockStart = null;
	let clockEnd = null;

	const curated =
		CURATED_COPY[slugKey] ||
		(/bike night/i.test(title) ? BIKE_NIGHT : null) ||
		(/cars\s*&\s*coffee|cars and coffee/i.test(title) ? CARS_COFFEE : null);

	if (curated) {
		event_intro = curated.event_intro;
		description = curated.description;
		clockStart = curated.clock_start;
		clockEnd = curated.clock_end;
	}

	// Detail scrape for motorsport pages when still thin
	if (row.source_url?.includes("circuitoftheamericas.com/event/")) {
		const detail = await scrapeCotaDetail(row.source_url);
		if (detail) {
			if (!payload.image_url && detail.ogImage) payload.image_url = detail.ogImage;
			if (detail.ogImage && detail.ogImage.length > (payload.image_url?.length ?? 0)) {
				payload.image_url = detail.ogImage;
			}
			if (detail.ticket) payload.ticket_url = detail.ticket;
			if (!description && detail.paras[0]) description = detail.paras[0];
			if (!description && detail.ogDesc && !/browser doesn|html5/i.test(detail.ogDesc)) {
				description = detail.ogDesc;
			}
			if (detail.h1 && detail.h1.length > 3) {
				// keep list title unless detail is clearer
			}
		}
	}

	// Fallback intros
	if (!event_intro) {
		event_intro = `${title} at ${venue.name} in Austin — part of Circuit of The Americas’ public events calendar.`;
	}
	if (!description) {
		description = `${title} takes place at Circuit of The Americas (9201 Circuit of the Americas Blvd, Austin, TX). Check the official listing for gate times, tickets, and parking. Multi-day motorsport weekends and community events both use the full Grand Prix facility — arrive early and follow COTA guidance for traffic and weather.`;
	}

	// Recompute starts/ends with better times
	const startYmd = row.parsed_starts_at?.slice(0, 10);
	const endYmd = parseEndYmd(row.raw_date_text || "", startYmd);
	if (startYmd && clockStart) {
		payload._starts_at = localToUtc(startYmd, clockStart);
	}
	if (endYmd && clockEnd) {
		payload._ends_at = localToUtc(endYmd, clockEnd);
	} else if (startYmd && clockEnd && !endYmd) {
		payload._ends_at = localToUtc(startYmd, clockEnd);
	}

	const city = venue.sites?.city ?? "Austin";
	const brand = venue.sites?.name ?? "Hey Austin";
	const dateStr = new Date(payload._starts_at || row.parsed_starts_at).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: TZ,
	});

	const seo_title = truncate(`${title} | COTA Austin | ${brand}`, 60);
	const seo_description = truncate(
		`${title} at Circuit of The Americas in ${city} on ${dateStr}. Tickets, times, and details.`,
		156,
	);
	const focus_keyphrase = truncate(`${title} Austin COTA`, 60);

	const nextPayload = {
		...payload,
		description,
		event_intro,
		genres: cls.genres,
		category_slug,
		category_id: catBySlug[category_slug]?.id ?? payload.category_id ?? null,
		schema_type: cls.schema_type,
		seo_title,
		seo_description,
		focus_keyphrase,
		confidence: 1,
		// keep ticket_url / image_url
	};

	const updates = {
		raw_payload: nextPayload,
		// store refined times on the ingested row too
		parsed_starts_at: payload._starts_at || row.parsed_starts_at,
		parsed_ends_at: payload._ends_at || row.parsed_ends_at,
	};
	// clean internal keys from payload
	delete nextPayload._starts_at;
	delete nextPayload._ends_at;
	updates.raw_payload = nextPayload;

	const { error: uErr } = await sb.from("ingested_events").update(updates).eq("id", row.id);
	if (uErr) {
		console.error("FAIL", title, uErr.message);
		continue;
	}
	console.log("✓", title);
	console.log(
		"   ",
		updates.parsed_starts_at?.slice(0, 16),
		"→",
		updates.parsed_ends_at?.slice(0, 16) || "—",
		"|",
		category_slug,
		"|",
		cls.genres.join(", "),
	);
	console.log("    tix:", (nextPayload.ticket_url || "").slice(0, 70));
	console.log("    img:", nextPayload.image_url ? "yes" : "NO");
}

console.log("\nCuration complete.");

if (doApprove) {
	console.log("\nRunning bulk approve…\n");
	const { spawnSync } = await import("child_process");
	const r = spawnSync(
		process.execPath,
		[
			"scripts/approve-pending.mjs",
			"--confirm-bulk-approve",
			"circuit-of-the-americas",
			"--with-metadata",
		],
		{ cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), stdio: "inherit" },
	);
	// Windows path fix for cwd
	if (r.error || r.status !== 0) {
		// try relative
		const r2 = spawnSync(
			"node",
			[
				"scripts/approve-pending.mjs",
				"--confirm-bulk-approve",
				"circuit-of-the-americas",
				"--with-metadata",
			],
			{ cwd: process.cwd(), stdio: "inherit" },
		);
		process.exit(r2.status ?? 1);
	}
} else {
	console.log("\nNext: node scripts/curate-cota.mjs --approve");
	console.log("   or: node scripts/approve-pending.mjs --confirm-bulk-approve circuit-of-the-americas --with-metadata\n");
}
