const res = await fetch("https://stubbsaustin.com/concert-calendar/", {
	headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
});
const h = await res.text();
console.log("status", res.status);
console.log("event-discovery plugin", /event-discovery/i.test(h));
console.log("get_events_for_calendar", /get_events_for_calendar/i.test(h));
console.log("nonce", h.match(/"nonce"\s*:\s*"([^"]+)"/)?.[1] ?? "—");
console.log("ajax", h.match(/"ajax_url"\s*:\s*"([^"]+)"/)?.[1] ?? "—");