/**
 * Quick local parser smoke test (no worker deploy required).
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const { parseWebflowListingCards } = await import("../src/lib/sources/webflow-events.ts");
const { extractMecEventSlugs, resolveMecAgendaUrl, isMecCalendar } = await import("../src/lib/sources/mec.ts");

const hotelHtml = await (await fetch("https://texashotelvegas.com/calendar/", { headers: { "User-Agent": UA } })).text();
console.log("Hotel MEC?", isMecCalendar(hotelHtml, "https://texashotelvegas.com/calendar/"));
const agendaUrl = resolveMecAgendaUrl(hotelHtml, "https://texashotelvegas.com/calendar/");
console.log("agenda:", agendaUrl);
const agendaHtml = await (await fetch(agendaUrl, { headers: { "User-Agent": UA } })).text();
const slugs = extractMecEventSlugs(agendaHtml);
console.log("hotel slugs:", slugs.length, slugs.slice(0, 5));

const mwHtml = await (await fetch("https://www.meanwhilebeer.com/events", { headers: { "User-Agent": UA } })).text();
const cards = parseWebflowListingCards(mwHtml);
console.log("meanwhile cards:", cards.length);
console.log("samples:", cards.slice(0, 5).map((c) => ({ title: c.title, date: c.datePart, time: c.clock, ticket: Boolean(c.ticketUrl) })));