/**
 * Stage COTA events into ingested_events (bypasses stuck workflow artist-catalog step).
 * Uses the same list/detail rules as src/lib/sources/cota-events.ts
 *
 *   node scripts/stage-cota-local.mjs
 */
import { createHash, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LIST = "https://circuitoftheamericas.com/events/?layout=list";
const SLUG = "circuit-of-the-americas";
const TZ = "America/Chicago";

const MONTHS = {
	jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
	may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
	september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function strip(s) {
	return String(s || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#8211;|&#8212;/g, "–")
		.replace(/&#038;/g, "&")
		.replace(/&nbsp;/gi, " ")
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
function parseDateRange(raw) {
	const text = strip(raw);
	const range = text.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s+(\d{4})/i,
	);
	if (range) {
		const mon = MONTHS[range[1].toLowerCase()];
		if (!mon) return null;
		return { startYmd: `${range[4]}-${pad2(mon)}-${pad2(+range[2])}`, raw: text, multi: true };
	}
	const single = text.match(
		/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
	);
	if (!single) return null;
	const mon = MONTHS[single[1].toLowerCase()];
	if (!mon) return null;
	return { startYmd: `${single[3]}-${pad2(mon)}-${pad2(+single[2])}`, raw: text, multi: false };
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
function fp(title, starts, ticket) {
	return createHash("sha1")
		.update(`${title.toLowerCase()}|${starts.slice(0, 16)}|${ticket ?? ""}`)
		.digest("hex")
		.slice(0, 32);
}

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

const { data: venue } = await sb
	.from("venues")
	.select("id, name, address, site_id")
	.eq("slug", SLUG)
	.single();
if (!venue) throw new Error("venue missing");

console.log("Fetching list…");
const html = await (await fetch(LIST, { headers: { "user-agent": UA } })).text();
const parts = html.split(/(?=<div class="event-column d-flex\s*">)/i);
const rows = [];
const seen = new Set();
for (const part of parts) {
	if (!/event-column d-flex/i.test(part)) continue;
	const chunk = part.slice(0, 2800);
	const tag = strip(chunk.match(/class="event-tag"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
	const title = strip(chunk.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
	const rawDate = strip(chunk.match(/class="event-date"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
	if (!title || !rawDate || /concert/i.test(tag)) continue;
	const hrefs = [...chunk.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
	if (hrefs.some((h) => /germaniaamp\.com\/events\//i.test(h))) continue;
	const cotaDetail = hrefs.find((h) => /circuitoftheamericas\.com\/event\//i.test(h));
	const external =
		hrefs.find((h) =>
			/ticketmaster\.com|bikereg\.com|universe\.com|tixr\.com|am\.ticketmaster/i.test(h),
		) ?? null;
	const primaryUrl = cotaDetail ?? external;
	if (!primaryUrl) continue;
	const parsed = parseDateRange(rawDate);
	if (!parsed) continue;
	const key = `${title.toLowerCase()}|${parsed.startYmd}`;
	if (seen.has(key)) continue;
	seen.add(key);
	const imageUrl =
		chunk.match(/background-image:\s*url\(([^)]+)\)/i)?.[1]?.replace(/['"]/g, "") ?? null;
	const slug = cotaDetail ? cotaDetail.replace(/\/$/, "").split("/").pop() : null;
	rows.push({
		title,
		tag,
		rawDate: parsed.raw,
		startYmd: parsed.startYmd,
		multi: parsed.multi,
		primaryUrl,
		imageUrl,
		isCotaDetail: Boolean(cotaDetail),
		slug,
	});
}

console.log(`List rows (non-concert): ${rows.length}`);

const events = [];
for (const row of rows) {
	let title = row.title;
	let rawDate = row.rawDate;
	let startYmd = row.startYmd;
	let multi = row.multi;
	let ticketUrl = row.isCotaDetail ? null : row.primaryUrl;
	let imageUrl = row.imageUrl;
	let description = null;

	if (row.isCotaDetail) {
		try {
			const dhtml = await (
				await fetch(row.primaryUrl, { headers: { "user-agent": UA } })
			).text();
			const h1 = strip(dhtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
			if (h1) title = h1;
			const formula = strip(
				dhtml.match(/class="[^"]*formula-date[^"]*"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i)?.[1] ??
					"",
			);
			const fp2 = formula ? parseDateRange(formula) : null;
			if (fp2) {
				rawDate = fp2.raw;
				startYmd = fp2.startYmd;
				multi = fp2.multi;
			}
			const tm = dhtml.match(
				/href=["'](https?:\/\/(?:www\.)?ticketmaster\.com\/(?!.*venue\/)[^"']+)["']/i,
			)?.[1];
			if (tm && !/germania-insurance/i.test(tm)) ticketUrl = tm.replace(/&amp;/g, "&");
			else {
				const am = dhtml.match(
					/href=["'](https?:\/\/am\.ticketmaster\.com\/cota\/[^"']*)["']/i,
				)?.[1];
				if (am) ticketUrl = am.replace(/&amp;/g, "&");
			}
			const og = dhtml.match(/property="og:image"\s+content=["']([^"']+)["']/i)?.[1];
			if (og) imageUrl = og;
			const para = strip(dhtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
			if (para.length > 40) description = para.slice(0, 2000);
		} catch (e) {
			console.warn("detail fail", row.primaryUrl, e.message);
		}
	}

	const clock = multi ? "09:00:00" : "10:00:00";
	const starts = localToUtc(startYmd, clock);
	const t = new Date(starts).getTime();
	if (t < Date.now() - 3600_000) continue;

	events.push({
		title,
		starts_at: starts,
		raw_date_text: rawDate,
		source_url: row.primaryUrl,
		source_event_id: row.slug ?? `${title.toLowerCase().replace(/\s+/g, "-")}-${startYmd}`,
		fingerprint: fp(title, starts, ticketUrl),
		source_partner: "cota",
		ticket_url: ticketUrl,
		image_url: imageUrl,
		description,
		tag: row.tag,
	});
	console.log(`  ✓ ${startYmd}  ${title}`);
}

if (!events.length) {
	console.error("No events to stage");
	process.exit(1);
}

// Mark stuck run failed if any
await sb
	.from("ingestion_runs")
	.update({
		status: "error",
		error_message: "superseded by stage-cota-local.mjs",
		finished_at: new Date().toISOString(),
	})
	.eq("venue_id", venue.id)
	.eq("status", "running");

const { data: run, error: runErr } = await sb
	.from("ingestion_runs")
	.insert({
		site_id: venue.site_id,
		venue_id: venue.id,
		status: "success",
		started_at: new Date().toISOString(),
		finished_at: new Date().toISOString(),
	})
	.select("id")
	.single();
if (runErr) throw new Error(runErr.message);

const insertRows = events.map((e) => ({
	ingestion_run_id: run.id,
	venue_id: venue.id,
	raw_title: e.title,
	raw_date_text: e.raw_date_text,
	parsed_starts_at: e.starts_at,
	parsed_ends_at: null,
	source_url: e.source_url,
	source_event_id: e.source_event_id,
	fingerprint: e.fingerprint,
	source_partner: e.source_partner,
	match_status: "new",
	review_status: "pending",
	raw_payload: {
		description: e.description,
		ticket_url: e.ticket_url,
		image_url: e.image_url,
		confidence: 1,
		import_method: "feed",
		publish_mode: "draft",
		original_title: e.title,
		event_tag: e.tag,
	},
}));

const { data: inserted, error: insErr } = await sb
	.from("ingested_events")
	.insert(insertRows)
	.select("id, raw_title, parsed_starts_at");
if (insErr) throw new Error(insErr.message);

await sb
	.from("venue_event_sources")
	.update({
		calendar_url: LIST,
		feed_url: LIST,
		last_scrape_at: new Date().toISOString(),
		last_scrape_status: "success",
		last_scrape_error: null,
		last_event_imported_at: events.map((e) => e.starts_at).sort().at(-1) ?? null,
		updated_at: new Date().toISOString(),
	})
	.eq("venue_id", venue.id);

console.log(`\nStaged ${inserted?.length ?? 0} pending events for Circuit of The Americas`);
console.log("Review in admin /ingestion\n");
for (const r of inserted ?? []) {
	console.log(" -", r.parsed_starts_at?.slice(0, 10), r.raw_title);
}
