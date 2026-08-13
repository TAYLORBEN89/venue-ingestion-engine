import { writeFileSync } from "fs";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const listUrl = "http://germaniaamp.com/events/";
const r = await fetch(listUrl, {
	headers: { "user-agent": UA, accept: "text/html" },
	redirect: "follow",
});
const html = await r.text();
console.log("list", r.status, r.url, html.length);
writeFileSync("scripts/tmp-germania-events.html", html);

// rough card split
const cards = html.split(/class="[^"]*card events[^"]*"/i);
console.log("card splits", cards.length - 1);

// sample first card block after first match
const m = html.match(
	/<div[^>]*class="[^"]*card events[^"]*"[^>]*>[\s\S]{0,2500}/i,
);
console.log("\nFIRST CARD SNIPPET:\n", m?.[0]?.slice(0, 2000));

// upcoming-shows section
const up = html.match(
	/<div[^>]*class="[^"]*upcoming-shows[^"]*"[^>]*>[\s\S]{0,5000}/i,
);
console.log("\nUPCOMING SNIPPET:\n", up?.[0]?.slice(0, 1500));

// collect event links
const links = [
	...html.matchAll(/href=["'](https?:\/\/germaniaamp\.com\/events\/[^"'#]+)["']/gi),
].map((x) => x[1]);
const uniq = [...new Set(links)].filter((u) => !u.endsWith("/events") && !u.endsWith("/events/"));
console.log("\nevent links", uniq.length, uniq.slice(0, 20));

// detail
const detailUrl = uniq[0] || "http://germaniaamp.com/events/motionless-in-white";
const d = await fetch(detailUrl, {
	headers: { "user-agent": UA, accept: "text/html" },
	redirect: "follow",
});
const dhtml = await d.text();
console.log("\ndetail", detailUrl, d.status, dhtml.length);
writeFileSync("scripts/tmp-germania-detail.html", dhtml);

const bits = {
	h1: dhtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1],
	h2title: [...dhtml.matchAll(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi)].map(
		(x) => x[1],
	),
	subtitle: [...dhtml.matchAll(/<h2[^>]*class="[^"]*subtitle[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi)].map(
		(x) => x[0].replace(/\s+/g, " ").slice(0, 200),
	),
	about: dhtml.match(/About the Artist[\s\S]{0,2000}/i)?.[0]?.replace(/\s+/g, " ").slice(0, 800),
	dates: [
		...dhtml.matchAll(
			/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}/gi,
		),
	].map((x) => x[0]),
	tickets: [
		...dhtml.matchAll(/href=["'](https?:\/\/[^"']*(?:ticketmaster|livenation|ticket)[^"']*)["']/gi),
	].map((x) => x[1]),
	artistImgs: [
		...dhtml.matchAll(/src=["'](https?:\/\/[^"']*artist-images[^"']*)["']/gi),
	].map((x) => x[1]),
	rackcdn: [...dhtml.matchAll(/src=["'](https?:\/\/[^"']*rackcdn[^"']*)["']/gi)]
		.map((x) => x[1])
		.slice(0, 15),
};
console.log(JSON.stringify(bits, null, 2));

// structure around About the Artist
const ai = dhtml.indexOf("About the Artist");
if (ai >= 0) console.log("\nABOUT CTX\n", dhtml.slice(ai - 100, ai + 2500).replace(/\s+/g, " "));
