const calUrl = "https://www.capcitycomedy.com/calendar";
const calHtml = await (await fetch(calUrl, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
const headshots = [...calHtml.matchAll(/talent\/headshots\/[^"'\s<>]+/gi)].slice(0, 3);
console.log("calendar headshots:", headshots.length, headshots[0]?.[0]?.slice(0, 80));
const showId = calHtml.match(/\/shows\/(\d+)/)?.[1];
console.log("first show id:", showId);
if (showId) {
	const base = calHtml.match(/https:\/\/[^"']*seatengine\.com/i)?.[0] ?? "https://cap-city-comedy-club-cap-city-comedy-club.seatengine.com";
	const origin = new URL(base.includes("http") ? base : `https://${base}`).origin;
	const showHtml = await (await fetch(`${origin}/shows/${showId}`)).text();
	const imgs = [...showHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 6);
	console.log("show imgs:", imgs);
}