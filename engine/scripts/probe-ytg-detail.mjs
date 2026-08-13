const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const url = "https://moodyamphitheater.com/events/young-the-giant";
const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
const html = await res.text();

const iframes = [...html.matchAll(/<iframe[^>]+>/gi)].map((m) => m[0]);
console.log("iframes:", iframes);

const ticketm = [...html.matchAll(/.{0,80}ticketm.{0,120}/gi)].map((m) => m[0]);
console.log("ticketm context:", ticketm);

const og =
	html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
	html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
console.log("og:image:", og);

const ytIds = [
	...new Set(
		[
			...[...html.matchAll(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/gi)].map((m) => m[1]),
			...[...html.matchAll(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/gi)].map((m) => m[1]),
		],
	),
];
console.log("youtube ids:", ytIds);