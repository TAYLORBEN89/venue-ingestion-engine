const html = await (
	await fetch("https://moodycenteratx.com/event/dude-perfect/", {
		headers: { "User-Agent": "Mozilla/5.0" },
	})
).text();
console.log("len", html.length);
for (const p of ["ticketm", "dam/", "wp-content/uploads", "og:image", "tribe-events", "ticketmaster"]) {
	const n = (html.match(new RegExp(p, "gi")) || []).length;
	if (n) console.log(p, n);
}
const uploads = [...html.matchAll(/https:\/\/moodycenteratx\.com\/wp-content\/uploads\/[^"'\s]+/gi)].map((m) => m[0]);
console.log("uploads", uploads.slice(0, 10));