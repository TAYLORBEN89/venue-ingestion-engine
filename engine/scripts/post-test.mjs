const res = await fetch("https://events-platform-ingestion.ben-745.workers.dev/test-source", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		calendarUrl: "https://stubbsaustin.com/concert-calendar/",
		venueName: "Stubb's",
		scrapeDaysAhead: 90,
	}),
});
console.log(res.status, await res.text());