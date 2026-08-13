import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamic import of compiled TS won't work — inline the probe using same regex logic.
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const url = "https://moodyamphitheater.com/events/young-the-giant";
const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
const html = await res.text();

const og =
	html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
	html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];

const iframes = [...html.matchAll(/<iframe[^>]*>/gi)].map((m) => m[0]).filter((b) => /youtube/i.test(b));
const ticketUrl = html.match(/href=["'](https:\/\/www\.ticketmaster\.com\/event\/[^"']+)["']/i)?.[1];

console.log("og:image:", og);
console.log("ticketmaster:", ticketUrl);
console.log("youtube iframes:", iframes.length);
for (const frame of iframes.slice(0, 2)) console.log(" ", frame.slice(0, 120));

// Listing ticket link fix
const listingRes = await fetch("https://moodyamphitheater.com/events-tickets", {
	headers: { "User-Agent": UA },
});
const listing = await listingRes.text();
const chunkIdx = listing.indexOf("young-the-giant");
const chunk = listing.slice(chunkIdx, chunkIdx + 1800);
const tmTicket = chunk.match(/href=["'](https:\/\/www\.ticketmaster\.com\/event\/[^"']+)["']/i)?.[1];
console.log("\nlisting ticket URL for YTG:", tmTicket);