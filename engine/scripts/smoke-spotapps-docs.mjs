/**
 * Local smoke: parse Doc's SpotApps pinboard/agenda HTML (no TS imports).
 * Mirrors parseSpotAppsPinboardEvents in src/lib/sources/spotapps.ts
 *
 * Usage (from apps/ingestion):
 *   node scripts/smoke-spotapps-docs.mjs [path-to-html]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");
const htmlPath = process.argv[2] || path.join(root, "tmp-docs-events.html");
const calendarUrl = "https://eatdrinkdocs.com/events";

if (!fs.existsSync(htmlPath)) {
	console.error("Missing HTML. Fetch:\n  curl -sL https://eatdrinkdocs.com/events -o tmp-docs-events.html");
	process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf8");
console.log("is pinboard:", /event-calendar-card/i.test(html) && /pinboardAgendaContainer|data-event-start-date/i.test(html));
console.log("event-calendar-card count:", (html.match(/event-calendar-card/gi) || []).length);

function stripTags(s) {
	return String(s || "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&#039;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/\s+/g, " ")
		.trim();
}

function absImg(src) {
	if (!src) return null;
	if (src.startsWith("//")) return `https:${src}`;
	return src;
}

function extractCards(htmlIn) {
	const starts = [];
	const re = /<div\b[^>]*\bevent-calendar-card\b[^>]*>/gi;
	let m;
	while ((m = re.exec(htmlIn))) starts.push(m.index);
	return starts.map((start, i) => {
		const end = starts[i + 1] ?? Math.min(htmlIn.length, start + 6000);
		return htmlIn.slice(start, end);
	});
}

const scope =
	html.match(
		/id=["']pinboardAgendaContainer["'][^>]*>([\s\S]*?)(?=<div\b[^>]*id=["'](?:pinboard|calendar|noEvents)|$)/i,
	)?.[1] ?? html;

const cards = extractCards(scope);
const events = [];
const seen = new Set();

for (const body of cards) {
	const id = body.match(/\bid=["'](\d+)["']/i)?.[1] ?? "";
	const startDate = body.match(/data-event-start-date=["']([^"']+)["']/i)?.[1] ?? "";
	const startTime = body.match(/data-event-start-time=["']([^"']+)["']/i)?.[1] ?? "20:00";
	const ymd = startDate.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
	const title = stripTags(body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "");
	if (!ymd || !title || title.length < 2) continue;
	const clock = startTime.match(/^(\d{1,2}):(\d{2})/)
		? `${String(Number(startTime.split(":")[0])).padStart(2, "0")}:${startTime.split(":")[1].slice(0, 2)}:00`
		: "20:00:00";
	const startLocal = `${ymd} ${clock}`;
	const img = absImg(
		body.match(/class=["'][^"']*\bimg-responsive\b[^"']*["'][^>]*src=["']([^"']+)["']/i)?.[1] ||
			body.match(/src=["']((?:https?:)?\/\/static\.spotapps\.co\/[^"']+)["']/i)?.[1],
	);
	const dayLabel = stripTags(
		body.match(/class=["'][^"']*\bevent-day\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "",
	);
	const key = `${title.toLowerCase()}|${startLocal}`;
	if (seen.has(key)) continue;
	seen.add(key);
	events.push({ id, title, startLocal, img: !!img, dayLabel, source_event_id: id ? `spotapps:${id}` : null });
}

events.sort((a, b) => a.startLocal.localeCompare(b.startLocal));
console.log(`\nParsed ${events.length} events:\n`);
for (const e of events) {
	console.log("-", e.startLocal, "|", e.title.slice(0, 60), "|", e.img ? "img" : "NOIMG", "|", e.source_event_id);
}

if (events.length < 1) {
	console.error("\nFAIL");
	process.exit(1);
}
console.log("\nOK — pinboard parse ready for Doc's pilot");
