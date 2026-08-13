/**
 * Re-fetch ACL Live event pages and set real AXS/TM Get Tickets URLs
 * on pending ingested_events (and published/draft events if linked).
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
	readFileSync("./.dev.vars", "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function extractTicketUrl(html, fallback) {
	const hrefs = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) =>
		m[1].replace(/&amp;/g, "&"),
	);
	const prefer = hrefs.filter((h) =>
		/axs\.com\/events\/\d+|ticketmaster\.com\/event\/|ticketmaster\.com\/.*\/event|livenation\.com\/.*tickets/i.test(
			h,
		),
	);
	const ticketClass = [
		...html.matchAll(/href="(https?:\/\/[^"]+)"[^>]*class="[^"]*tickets[^"]*"/gi),
		...html.matchAll(/class="[^"]*tickets[^"]*"[^>]*href="(https?:\/\/[^"]+)"/gi),
	].map((m) => m[1].replace(/&amp;/g, "&"));
	let url =
		prefer.find((h) => /axs\.com\/events\/\d+/i.test(h)) ||
		ticketClass.find((h) => /^https?:\/\//i.test(h) && !/data\.link/i.test(h)) ||
		prefer[0] ||
		null;
	if (!url) return fallback;
	url = url.split(/[?&]_gl=/)[0].replace(/[?&]$/, "");
	return url;
}

const { data: venues } = await sb
	.from("venues")
	.select("id, slug")
	.in("slug", ["acl-live"]);

let updated = 0;
let axs = 0;
let fail = 0;

for (const v of venues ?? []) {
	const { data: rows } = await sb
		.from("ingested_events")
		.select("id, source_url, source_event_id, raw_payload, raw_title, review_status")
		.eq("venue_id", v.id)
		.in("review_status", ["pending", "approved"]);

	console.log(`\n${v.slug}: ${rows?.length ?? 0} rows`);
	for (const row of rows ?? []) {
		const page =
			row.source_url ||
			(row.source_event_id?.startsWith("/")
				? `https://www.acllive.com${row.source_event_id}`
				: row.source_event_id);
		if (!page || !/acllive\.com/i.test(page)) continue;
		try {
			const html = await (
				await fetch(page, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) })
			).text();
			const ticket = extractTicketUrl(html, page);
			const prev = row.raw_payload?.ticket_url;
			const payload = { ...(row.raw_payload || {}), ticket_url: ticket };
			await sb.from("ingested_events").update({ raw_payload: payload }).eq("id", row.id);

			// Also patch published/draft events matched by source_event_id
			if (row.source_event_id) {
				await sb
					.from("events")
					.update({ ticket_url: ticket, updated_at: new Date().toISOString() })
					.eq("venue_id", v.id)
					.eq("source_event_id", row.source_event_id);
			}

			const isAxs = /axs\.com|ticketmaster/i.test(ticket);
			if (isAxs) axs++;
			updated++;
			if (updated <= 5 || isAxs !== /axs\.com|ticketmaster/i.test(prev || "")) {
				console.log(
					`  ${isAxs ? "✓" : "·"} ${row.raw_title?.slice(0, 36)} → ${ticket.slice(0, 70)}`,
				);
			}
			await new Promise((r) => setTimeout(r, 80));
		} catch (e) {
			fail++;
			console.log(`  fail ${row.raw_title}: ${e.message}`);
		}
	}
}

console.log(`\nDone. updated=${updated} with_axs_or_tm≈${axs} fail=${fail}`);
