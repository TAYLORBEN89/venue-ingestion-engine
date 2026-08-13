const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const agendaUrl =
	"https://texashotelvegas.com/all-events/action~agenda/cat_ids~2351/events_limit~50/request_format~html/";
const agendaHtml = await (await fetch(agendaUrl, { headers: { "User-Agent": UA } })).text();
console.log("agenda len", agendaHtml.length);

const relLinks = [
	...new Set([...agendaHtml.matchAll(/href=["'](\/event\/[^"'#?]+)["']/gi)].map((m) => m[1])),
];
console.log("relative /event/ links:", relLinks.length);
console.log(relLinks.slice(0, 12).join("\n"));

const encoded = [...agendaHtml.matchAll(/texashotelvegas\.com&#x2F;event&#x2F;[^&]+/gi)].map((m) => m[0]).slice(0, 5);
console.log("encoded links:", encoded);

const titles = [...agendaHtml.matchAll(/class=["']mec-event-title[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)]
	.map((m) => m[1].replace(/<[^>]+>/g, "").trim())
	.slice(0, 10);
console.log("mec-event-title samples:", titles);

const dateBlocks = [...agendaHtml.matchAll(/class=["']mec-event-date[^"']*["'][^>]*>([\s\S]*?)<\//gi)]
	.map((m) => m[1].replace(/<[^>]+>/g, " ").trim())
	.slice(0, 8);
console.log("mec-event-date samples:", dateBlocks);

// Meanwhile listing titles
const listHtml = await (await fetch("https://www.meanwhilebeer.com/events", { headers: { "User-Agent": UA } })).text();
const slugs = [...new Set([...listHtml.matchAll(/href=["']\/events\/([^"'#?]+)["']/gi)].map((m) => m[1]))];
console.log("\nmeanwhile slugs:", slugs.length, slugs.slice(0, 8));

const cardTitles = [...listHtml.matchAll(/href=["']\/events\/([^"'#?]+)["'][^>]*>([\s\S]{0,200})/gi)].slice(0, 3);
for (const [, slug, tail] of cardTitles) {
	console.log("slug", slug, "tail", tail.replace(/\s+/g, " ").slice(0, 100));
}

// search title patterns in meanwhile detail
const detail = await (await fetch("https://www.meanwhilebeer.com/events/tuesday-trivia-73", { headers: { "User-Agent": UA } })).text();
console.log("\nmeanwhile detail <title>:", detail.match(/<title[^>]*>([^<]+)/i)?.[1]);
const og = [...detail.matchAll(/<meta[^>]+>/gi)]
	.filter((m) => /og:|twitter:|description/i.test(m[0]))
	.slice(0, 8)
	.map((m) => m[0].replace(/\s+/g, " "));
console.log("meta tags:", og.join("\n"));
const wfTitle = detail.match(/class=["'][^"']*event-name[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1];
console.log("event-name:", wfTitle?.replace(/<[^>]+>/g, "").trim());