import { readFileSync } from "fs";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const calendarHtml = await (await fetch("https://texashotelvegas.com/calendar/", { headers: { "User-Agent": UA } })).text();
const eventLinks = [
	...new Set(
		[...calendarHtml.matchAll(/href=["'](https?:\/\/texashotelvegas\.com\/event\/[^"'#?]+)["']/gi)].map((m) => m[1]),
	),
];
console.log("calendar event links:", eventLinks.length);
console.log(eventLinks.slice(0, 10).join("\n"));

const mecClasses = [...new Set([...calendarHtml.matchAll(/\bmec-[a-z0-9-]+\b/gi)].map((m) => m[0]))].sort();
console.log("\nmec classes:", mecClasses.slice(0, 30).join(", "));

// Agenda HTML endpoint
const agendaUrl =
	"https://texashotelvegas.com/all-events/action~agenda/cat_ids~2351/events_limit~50/request_format~html/";
const agendaHtml = await (await fetch(agendaUrl, { headers: { "User-Agent": UA } })).text();
console.log("\nagenda len", agendaHtml.length);
const agendaLinks = [
	...new Set(
		[...agendaHtml.matchAll(/href=["'](https?:\/\/texashotelvegas\.com\/event\/[^"'#?]+)["']/gi)].map((m) => m[1]),
	),
];
console.log("agenda event links:", agendaLinks.length);
console.log(agendaLinks.slice(0, 8).join("\n"));

// Sample event card from agenda
const card = agendaHtml.match(/<article[\s\S]{0,2500}?<\/article>/i)?.[0];
if (card) {
	console.log("\nSample article snippet:");
	console.log(card.slice(0, 1200).replace(/\s+/g, " "));
}

if (eventLinks[0]) {
	const detail = await (await fetch(eventLinks[0], { headers: { "User-Agent": UA } })).text();
	console.log("\nDetail", eventLinks[0]);
	console.log("h1:", detail.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim());
	const start = detail.match(/class=["'][^"']*mec-start-date[^"']*["'][^>]*>([\s\S]*?)<\//i);
	console.log("mec-start-date:", start?.[1]?.replace(/<[^>]+>/g, " ").trim());
	const time = detail.match(/class=["'][^"']*mec-start-time[^"']*["'][^>]*>([\s\S]*?)<\//i);
	console.log("mec-start-time:", time?.[1]?.replace(/<[^>]+>/g, " ").trim());
	// fallback date patterns in detail
	const dateMeta = detail.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
	console.log("time datetime:", dateMeta);
	const ogTitle = detail.match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
	console.log("og:title:", ogTitle);
}