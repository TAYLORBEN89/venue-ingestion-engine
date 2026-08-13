const venueId = "af804d04-6be1-4232-9274-baf20bd608bf";
const sourceId = "146e5d69-c778-42cc-a646-7f13923188fa";

const res = await fetch("https://events-platform-ingestion.ben-745.workers.dev/ingest", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ venueId, sourceId }),
});
console.log(res.status, await res.text());