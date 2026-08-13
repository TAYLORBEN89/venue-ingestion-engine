const TICKET_LABELS =
	/Tickets|RSVP|Buy Tickets|More Info|Eventbrite|See Tickets|Get Tickets|Purchase/i;

const TICKET_VENDOR_HOSTS = [
	"eventbrite.com",
	"axs.com",
	"dice.fm",
	"universe.com",
	"prekindle.com",
	"seetickets.us",
	"ticketmaster.com",
	"etix.com",
	"ticketweb.com",
	"seated.com",
	"seatengine.com",
	"tixr.com",
	"showclix.com",
];

function isTicketVendorUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.replace(/^www\./, "");
		return TICKET_VENDOR_HOSTS.some((vendor) => host === vendor || host.endsWith(`.${vendor}`));
	} catch {
		return false;
	}
}

function isValidTicketHref(href: string): boolean {
	const trimmed = href.trim();
	if (!trimmed || trimmed === "#" || /^javascript:/i.test(trimmed)) return false;
	return true;
}

/** Extract ticket URLs from rendered Markdown calendar content. */
export function extractTicketUrlFromMarkdown(markdown: string, eventTitle?: string): string | null {
	const links: string[] = [];

	// [Buy Tickets](https://...)
	const mdLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
	for (const match of markdown.matchAll(mdLinkRe)) {
		const label = match[1];
		const href = match[2];
		if (!isValidTicketHref(href)) continue;
		if (TICKET_LABELS.test(label) || isTicketVendorUrl(href)) {
			links.push(href);
		}
	}

	// Bare vendor URLs in the page
	const urlRe = /https?:\/\/[^\s)>"']+/g;
	for (const match of markdown.matchAll(urlRe)) {
		if (isTicketVendorUrl(match[0])) links.push(match[0]);
	}

	if (links.length === 0) return null;
	if (!eventTitle) return links[0];

	// Prefer a link appearing near the event title in the markdown.
	const titleIndex = markdown.toLowerCase().indexOf(eventTitle.toLowerCase());
	if (titleIndex >= 0) {
		const window = markdown.slice(titleIndex, titleIndex + 1500);
		const near = links.find((url) => window.includes(url));
		if (near) return near;
	}

	return links[0];
}

/** Pick the best ticket URL when multiple candidates exist on a parsed event. */
export function coalesceTicketUrl(...candidates: (string | null | undefined)[]): string | null {
	for (const candidate of candidates) {
		if (candidate && isValidTicketHref(candidate)) return candidate.trim();
	}
	return null;
}