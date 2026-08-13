function normalizePart(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeTicketUrl(url: string | null | undefined): string {
	if (!url) return "";
	try {
		const parsed = new URL(url);
		const hostPath = `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}`.toLowerCase();
		// Preserve identity query params (ACE SmartSeat itemNumber, event ids, etc.)
		// so distinct performances on the same path are not collapsed.
		const keepKeys = ["itemnumber", "item_number", "eventid", "event_id", "event", "id", "performanceid"];
		const kept: string[] = [];
		for (const [k, v] of parsed.searchParams.entries()) {
			if (keepKeys.includes(k.toLowerCase()) && v) {
				kept.push(`${k.toLowerCase()}=${v.toLowerCase()}`);
			}
		}
		kept.sort();
		return kept.length ? `${hostPath}?${kept.join("&")}` : hostPath;
	} catch {
		return normalizePart(url);
	}
}

/** Minute-precision UTC bucket for stable cross-run matching. */
function startBucket(startsAt: string): string {
	const date = new Date(startsAt);
	if (Number.isNaN(date.getTime())) return startsAt;
	return date.toISOString().slice(0, 16);
}

/**
 * Deterministic fingerprint: band/title + venue + start + ticket URL.
 * Ticket URL included when present for music events where the same band
 * might play the same venue on the same night with different ticket links.
 */
export function eventFingerprint(
	title: string,
	venueName: string,
	startsAt: string,
	ticketUrl?: string | null,
): string {
	const ticketPart = normalizeTicketUrl(ticketUrl);
	const base = `${normalizePart(title)}|${normalizePart(venueName)}|${startBucket(startsAt)}`;
	return ticketPart ? `${base}|${ticketPart}` : base;
}