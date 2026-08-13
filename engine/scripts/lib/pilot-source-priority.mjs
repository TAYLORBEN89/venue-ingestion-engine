/** Rank new pilot sources: structured feeds before custom_html / browser. */

const STRUCTURED_PLATFORM_TYPES = new Set([
	"event_discovery",
	"webflow",
	"seatengine",
	"mec",
	"tec",
	"prekindle",
	"ical",
	"ticketmaster",
]);

const URL_HINTS = [
	[/seatengine\.com/i, 100],
	[/website-files\.com|webflow/i, 90],
	[/prekindle\.com/i, 85],
	[/eventdiscovery/i, 80],
	[/\.ics|ical=1|feed\/ical/i, 75],
	[/ticketmaster/i, 70],
	[/tribe_events/i, 50],
];

const MUSIC_SLUG_HINTS = [
	/club|bar|lounge|room|theater|theatre|amphitheater|venue|music|live|cantina|brewery|bbq|bb-q|dance|hall|stage|antone|continental|elephant|cactus|scoot|mercer|sahara|white-horse|cheer/i,
];

export function pilotSourcePriority(source) {
	const venue = source.venues ?? {};
	const urls = [source.feed_url, venue.event_feed_url, venue.calendar_url].filter(Boolean).join(" ");
	let score = 0;

	if (source.platform_type && source.platform_type !== "auto") {
		score += STRUCTURED_PLATFORM_TYPES.has(source.platform_type) ? 120 : 10;
	}

	for (const [re, pts] of URL_HINTS) {
		if (re.test(urls)) score += pts;
	}

	if (MUSIC_SLUG_HINTS.some((re) => re.test(venue.slug ?? "") || re.test(venue.name ?? ""))) {
		score += 40;
	}

	// Deprioritize obvious non-music / tour operators
	if (/tour|rental|charter|party-bus|detour|flyboard|diner|gallery|hotel(?!.*vegas)/i.test(`${venue.slug} ${venue.name}`)) {
		score -= 60;
	}

	return score;
}

export function sortPilotSources(sources) {
	return [...sources].sort((a, b) => {
		const diff = pilotSourcePriority(b) - pilotSourcePriority(a);
		if (diff !== 0) return diff;
		return (a.venues?.slug ?? "").localeCompare(b.venues?.slug ?? "");
	});
}