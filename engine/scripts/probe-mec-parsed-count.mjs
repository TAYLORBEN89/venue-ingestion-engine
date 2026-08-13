import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const {
	buildMecAgendaOffsets,
	buildMecMonthUrls,
	resolveMecAgendaUrl,
	parseAi1ecAgendaEvents,
} = await import("../src/lib/sources/mec.ts");

const cal = await (await fetch("https://texashotelvegas.com/calendar/", { headers: { "User-Agent": UA } })).text();
const agendaUrl = resolveMecAgendaUrl(cal, "https://texashotelvegas.com/calendar/");
const catId = cal.match(/cat_ids~(\d+)/i)?.[1];
const urls = [...buildMecAgendaOffsets(agendaUrl), ...buildMecMonthUrls("https://texashotelvegas.com/calendar/", catId, 90)];
console.log("urls", urls.length);

let combined = "";
for (const url of urls) {
	try {
		const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
		combined += html;
		const blocks = html.split(/<div class="ai1ec-event /i).length - 1;
		console.log(blocks, "ai1ec blocks", url.replace("https://texashotelvegas.com", ""));
	} catch (e) {
		console.log("fail", url, e.message);
	}
}

const events = parseAi1ecAgendaEvents(combined, "America/Chicago", "https://texashotelvegas.com");
console.log("\nparsed events", events.length);
const cutoff = Date.now() + 90 * 24 * 60 * 60 * 1000;
const inWindow = events.filter((e) => new Date(e.starts_at).getTime() <= cutoff);
console.log("within 90d", inWindow.length);
console.log("date range", events[0]?.starts_at, "...", events.at(-1)?.starts_at);