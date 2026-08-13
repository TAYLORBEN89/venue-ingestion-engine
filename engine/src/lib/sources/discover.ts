import type { FeedType } from "../normalize";

const ICAL_URL_RE = /\.ics(\?|$)|webcal:\/\/|[?&]ical=1|\/feed\/ical\//i;
const GOOGLE_CAL_RE = /google\.com\/calendar/i;

export function detectFeedTypeFromUrl(url: string): FeedType | null {
	const normalized = url.replace(/^webcal:/i, "https:");
	if (ICAL_URL_RE.test(normalized)) return "ical";
	if (GOOGLE_CAL_RE.test(normalized)) return "google_calendar";
	return null;
}

export function toFetchableUrl(url: string): string {
	return url.replace(/^webcal:/i, "https:");
}

/** Scan an HTML events page for a linked iCal/Atom feed. */
export function discoverFeedUrlFromHtml(html: string, pageUrl: string): string | null {
	const linkRe =
		/<link[^>]+rel=["']alternate["'][^>]+type=["']text\/calendar["'][^>]+href=["']([^"']+)["'][^>]*>/gi;
	const altRe =
		/<link[^>]+type=["']text\/calendar["'][^>]+href=["']([^"']+)["'][^>]*>/gi;

	for (const re of [linkRe, altRe]) {
		const match = re.exec(html);
		if (match?.[1]) return new URL(match[1], pageUrl).toString();
	}

	// Common WordPress / The Events Calendar patterns.
	const hrefRe = /href=["']([^"']+(?:\?ical=1|feed\/ical\/|tribe\/events\/feed\/[^"']+))["']/i;
	const hrefMatch = hrefRe.exec(html);
	if (hrefMatch?.[1]) return new URL(hrefMatch[1], pageUrl).toString();

	return null;
}

export function resolveFeedType(explicit: FeedType | null, url: string): FeedType {
	if (explicit && explicit !== "auto" && explicit !== "scrape") return explicit;
	const detected = detectFeedTypeFromUrl(url);
	return detected ?? "scrape";
}