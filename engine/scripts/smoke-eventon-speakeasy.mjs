/**
 * Local smoke: Speakeasy EventON calendar walkthrough
 *   #evcal_list → detail → #evcal_next months
 * Usage: node scripts/smoke-eventon-speakeasy.mjs
 */
const CAL = "https://speakeasyaustin.com/calendar/";
const ORIGIN = "https://speakeasyaustin.com";
const TZ = "America/Chicago";
const DAYS = 120;
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function get(url) {
	const r = await fetch(url, {
		headers: { "user-agent": UA, accept: "text/html,*/*" },
		redirect: "follow",
		signal: AbortSignal.timeout(30000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
	return r.text();
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function appendNested(params, prefix, obj) {
	if (obj === null || obj === undefined) {
		params.append(prefix, "");
		return;
	}
	if (typeof obj !== "object" || Array.isArray(obj)) {
		params.append(prefix, String(obj));
		return;
	}
	for (const [k, v] of Object.entries(obj)) appendNested(params, `${prefix}[${k}]`, v);
}

function parseSc(html) {
	const scWide = html.match(
		/class=['"]evo_cal_data['"][\s\S]{0,40}data-sc=['"](\{[\s\S]{50,6000})['"]/i,
	);
	if (!scWide?.[1]) return null;
	const s = scWide[1];
	for (let end = Math.min(s.length, 3000); end > 80; end--) {
		const cand = s.slice(0, end);
		if (!cand.endsWith("}")) continue;
		try {
			return JSON.parse(cand);
		} catch {
			/* */
		}
	}
	return null;
}

function listUrls(html) {
	const out = new Set();
	// Prefer desc_trig (walkthrough), then every /events/ link in the AJAX list fragment
	const patterns = [
		/class=["'][^"']*desc_trig[^"']*["'][^>]*href=["']([^"']+)["']/gi,
		/href=["']([^"']+)["'][^>]*class=["'][^"']*desc_trig[^"']*["']/gi,
		/class=["'][^"']*evcal_list_a[^"']*["'][^>]*href=["']([^"']+)["']/gi,
		/href=["']([^"']*\/events\/[^"'#?]+)["']/gi,
	];
	for (const re of patterns) {
		for (const m of html.matchAll(re)) {
			let u = m[1].replace(/&amp;/g, "&").split("?")[0].replace(/\/$/, "") + "/";
			if (/\/events\//i.test(u) && !/\/(?:feed|page)\//i.test(u)) out.add(u);
		}
	}
	return [...out];
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

function localToUtc(local) {
	const [datePart, timePart] = local.replace("T", " ").split(" ");
	const [y, m, d] = datePart.split("-").map(Number);
	const [hh, mm, ss = 0] = (timePart || "20:00:00").split(":").map(Number);
	const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, +ss));
	return new Date(guess.getTime() - getOffsetMin(TZ, guess) * 60000).toISOString();
}

function parseStart(raw) {
	const m = String(raw).match(
		/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/,
	);
	if (!m) return null;
	return localToUtc(
		`${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")} ${String(+m[4]).padStart(2, "0")}:${m[5]}:${m[6] || "00"}`,
	);
}

function parseDetail(html, url) {
	let schema = null;
	for (const m of html.matchAll(
		/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		try {
			const j = JSON.parse(m[1]);
			if (j["@type"] === "Event" || j.startDate) {
				schema = j;
				break;
			}
		} catch {
			/* */
		}
	}
	const title = (schema?.name || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const startRaw = schema?.startDate;
	const starts_at = startRaw ? parseStart(startRaw) : null;
	const image =
		(typeof schema?.image === "string" ? schema.image : null) ||
		html.match(
			/evo_metarow_fimg[^>]*style=["'][^"']*background-image:\s*url\((['"]?)([^)'"]+)\1\)/i,
		)?.[2] ||
		null;
	const desc =
		html.match(/class=['"][^'"]*eventon_desc_in[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
		schema?.description ||
		"";
	const description = String(desc)
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const loc = html.match(/data-location_address=['"]([^'"]+)['"]/i)?.[1];
	const tickets = [
		...html.matchAll(/href=["'](https?:\/\/(?:www\.)?eventbrite\.com\/e\/[^"']+)["']/gi),
	].map((m) => m[1].replace(/&amp;/g, "&"));
	return {
		title,
		starts_at,
		image_url: image,
		description: description.length >= 40 ? description.slice(0, 180) + "…" : null,
		location: loc || null,
		ticket_url: tickets[0] || url,
		source_url: url,
	};
}

async function ajaxList(actionFields) {
	const r = await fetch(`${ORIGIN}/wp-admin/admin-ajax.php`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded; charset=UTF-8",
			"x-requested-with": "XMLHttpRequest",
			referer: CAL,
			origin: ORIGIN,
			"user-agent": UA,
		},
		body: actionFields.toString(),
	});
	const text = await r.text();
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

console.log("=== Speakeasy EventON calendar walkthrough smoke ===\n");
console.log("Calendar:", CAL);

const calHtml = await get(CAL);
const calId = calHtml.match(/id=['"](evcal_calendar_\d+)['"]/i)?.[1];
const sc = parseSc(calHtml);
console.log("calId", calId, "sc?", !!sc, "keys", sc && Object.keys(sc).length);
console.log("has #evcal_list", /id=['"]evcal_list['"]/i.test(calHtml));
console.log("has #evcal_next", /id=['"]evcal_next['"]/i.test(calHtml));

const urls = new Set();

// Month 0: eventon_init_load
if (calId && sc) {
	const p = new URLSearchParams();
	p.set("action", "eventon_init_load");
	appendNested(p, `cals[${calId}][sc]`, sc);
	const data = await ajaxList(p);
	const html = data?.cals?.[calId]?.html || "";
	const links = listUrls(html);
	console.log("init_load list links", links.length);
	for (const u of links) urls.add(u);
	console.log("  sample", links.slice(0, 6));
}

// #evcal_next months
for (let delta = 1; delta <= 3; delta++) {
	const fs = Number(sc.focus_start_date_range);
	const d0 = new Date(fs * 1000);
	const nextStart = Math.floor(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + delta, 1) / 1000);
	const nextEnd = Math.floor(
		Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + delta + 1, 0, 23, 59, 59) / 1000,
	);
	const nextSc = {
		...sc,
		focus_start_date_range: String(nextStart),
		focus_end_date_range: String(nextEnd),
		month_incre: String(delta),
	};
	const p = new URLSearchParams();
	p.set("action", "the_ajax_hook");
	p.set("direction", "next");
	p.set("ajaxtype", "switchmonth");
	appendNested(p, "shortcode", nextSc);
	const data = await ajaxList(p);
	const html = data?.html || "";
	const links = listUrls(html);
	console.log(`evcal_next +${delta}m links`, links.length, new Date(nextStart * 1000).toISOString().slice(0, 7));
	for (const u of links) urls.add(u);
	await sleep(100);
}

console.log("\nUnique list URLs:", urls.size);

const now = Date.now() - 3600000;
const cutoff = Date.now() + DAYS * 86400000;
const events = [];
const seen = new Set();
let i = 0;
for (const url of urls) {
	if (events.length >= 80) break;
	i++;
	try {
		const html = await get(url);
		const d = parseDetail(html, url);
		if (!d.title || !d.starts_at) {
			console.log(`  [${i}] skip ${url.replace(ORIGIN, "")}`);
			continue;
		}
		const t = Date.parse(d.starts_at);
		if (t < now || t > cutoff) {
			console.log(`  [${i}] out ${d.starts_at.slice(0, 10)} | ${d.title}`);
			continue;
		}
		const key = `${d.title}|${d.starts_at}`;
		if (seen.has(key)) continue;
		seen.add(key);
		events.push(d);
		console.log(
			`  [${i}] OK ${d.starts_at.slice(0, 16)} | ${d.title} | img=${!!d.image_url} loc=${!!d.location} tix=${/eventbrite/i.test(d.ticket_url)}`,
		);
	} catch (e) {
		console.log(`  [${i}] ERR ${e.message}`);
	}
	await sleep(80);
}

events.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
console.log("\n=== RESULT ===");
console.log(
	JSON.stringify(
		{
			platform: "eventon",
			walkthrough: "calendar #evcal_list → detail → #evcal_next",
			calendar: CAL,
			urls_from_list: urls.size,
			events_found: events.length,
			with_images: events.filter((e) => e.image_url).length,
			with_location: events.filter((e) => e.location).length,
			with_tickets: events.filter((e) => /eventbrite/i.test(e.ticket_url)).length,
			sample: events.slice(0, 15).map((e) => ({
				starts_at: e.starts_at,
				title: e.title,
				location: e.location,
				ticket: e.ticket_url?.slice(0, 55),
			})),
		},
		null,
		2,
	),
);
