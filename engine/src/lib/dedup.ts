import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventWithMetadata } from "./apply-event-metadata";
import type { EnrichedPartnerEvent } from "./enrich-from-artist";

const TITLE_MATCH_THRESHOLD = 0.85;
const TITLE_REVIEW_THRESHOLD = 0.55;
/** AI scrape often emits the same show at midnight UTC and local offset (~5h). */
const SAME_SHOW_MAX_HOURS = 18;

export type MatchStatus = "new" | "matched_existing" | "needs_review";

/** Input to dedup may be enriched-only or fully classified. */
type DedupInput = EnrichedPartnerEvent | EventWithMetadata;

export type MatchedPartnerEvent = DedupInput & {
	match_status: MatchStatus;
	matched_event_id: string | null;
	/** True when this row is a within-batch or pending-queue duplicate (should not stage). */
	is_duplicate: boolean;
	duplicate_of?: string | null;
	category_id?: string | null;
	category_slug?: string;
	/** Kind-aware schema.org type from applyEventMetadata */
	schema_type?: string;
};

interface ExistingEvent {
	id: string;
	title: string;
	starts_at: string;
	ticket_url: string | null;
	source_event_id: string | null;
	fingerprint: string | null;
	/** published event vs pending ingested row */
	kind: "event" | "ingested";
}

function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeTicket(url: string | null | undefined): string {
	if (!url) return "";
	try {
		const parsed = new URL(url);
		const hostPath = `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}`.toLowerCase();
		// Keep SmartSeat / ticketing identity params so multi-performance runs
		// (same path, different itemNumber) are not treated as one show.
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
		return url.toLowerCase();
	}
}

function titleSimilarity(a: string, b: string): number {
	const s1 = normalizeTitle(a);
	const s2 = normalizeTitle(b);
	if (s1 === s2) return 1;
	if (s1.length === 0 || s2.length === 0) return 0;

	const rows = s1.length + 1;
	const cols = s2.length + 1;
	const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
	for (let i = 0; i < rows; i++) dist[i][0] = i;
	for (let j = 0; j < cols; j++) dist[0][j] = j;
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
			dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
		}
	}
	const editDistance = dist[rows - 1][cols - 1];
	return 1 - editDistance / Math.max(s1.length, s2.length);
}

/** Same show window: exact minute, same calendar day, or within SAME_SHOW_MAX_HOURS. */
export function isSameShowWindow(aIso: string, bIso: string): boolean {
	if (!aIso || !bIso) return false;
	if (aIso.slice(0, 16) === bIso.slice(0, 16)) return true;
	if (aIso.slice(0, 10) === bIso.slice(0, 10)) return true;
	const ta = new Date(aIso).getTime();
	const tb = new Date(bIso).getTime();
	if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
	return Math.abs(ta - tb) <= SAME_SHOW_MAX_HOURS * 60 * 60 * 1000;
}

function dayKey(startsAt: string): string {
	return startsAt.slice(0, 10);
}

function isExactMusicDuplicate(existing: ExistingEvent, event: DedupInput): boolean {
	if (existing.fingerprint && existing.fingerprint === event.fingerprint) return true;

	const sameTitle = normalizeTitle(existing.title) === normalizeTitle(event.title);
	if (!sameTitle) return false;

	const sameTicket =
		Boolean(existing.ticket_url) &&
		Boolean(event.ticket_url) &&
		normalizeTicket(existing.ticket_url) === normalizeTicket(event.ticket_url);

	// Same ticket + title + same show window → same show (times may drift slightly).
	// Do NOT collapse multi-date series that share one booking page (e.g. Jester King
	// Guided Goat Walks all link to /tours-and-experiences/guided-goat-walk).
	if (sameTicket && isSameShowWindow(existing.starts_at, event.starts_at)) return true;

	return isSameShowWindow(existing.starts_at, event.starts_at);
}

/**
 * Prefer the richer/more plausible occurrence when collapsing duplicates.
 * Higher score wins.
 */
export function duplicatePreferenceScore(event: {
	starts_at: string;
	ticket_url?: string | null;
	image_url?: string | null;
	confidence?: number;
	description?: string | null;
}): number {
	let score = (event.confidence ?? 0) * 10;
	if (event.ticket_url) score += 5;
	if (event.image_url) score += 2;
	if (event.description) score += 1;
	const hour = new Date(event.starts_at).getUTCHours();
	// Prefer non-midnight-UTC starts (common AI timezone double)
	if (hour !== 0) score += 3;
	return score;
}

function matchByStableId(
	existing: ExistingEvent[],
	event: DedupInput,
): { id: string; status: MatchStatus } | null {
	if (event.source_event_id) {
		const byId = existing.find((row) => row.source_event_id === event.source_event_id);
		if (byId) return { id: byId.id, status: "matched_existing" };
	}

	for (const row of existing) {
		if (isExactMusicDuplicate(row, event)) {
			return { id: row.id, status: "matched_existing" };
		}
	}

	const byFingerprint = existing.find((row) => row.fingerprint === event.fingerprint);
	if (byFingerprint) return { id: byFingerprint.id, status: "matched_existing" };
	return null;
}

function matchByFuzzy(existing: ExistingEvent[], event: DedupInput): MatchedPartnerEvent {
	let best: { candidate: ExistingEvent; score: number } | null = null;

	for (const candidate of existing) {
		if (!isSameShowWindow(candidate.starts_at, event.starts_at)) continue;
		const score = titleSimilarity(event.title, candidate.title);
		if (!best || score > best.score) {
			best = { candidate, score };
		}
	}

	if (best && best.score >= TITLE_MATCH_THRESHOLD) {
		const sameTicket =
			normalizeTicket(best.candidate.ticket_url) === normalizeTicket(event.ticket_url);
		if (sameTicket || !event.ticket_url || !best.candidate.ticket_url) {
			return {
				...event,
				match_status: "matched_existing",
				matched_event_id: best.candidate.id,
				is_duplicate: true,
				duplicate_of: best.candidate.id,
			};
		}
	}

	const ambiguous = best !== null && best.score >= TITLE_REVIEW_THRESHOLD;
	const lowConfidence = event.confidence < TITLE_REVIEW_THRESHOLD;
	if (ambiguous || lowConfidence) {
		return {
			...event,
			match_status: "needs_review",
			matched_event_id: best?.candidate.id ?? null,
			is_duplicate: false,
		};
	}

	return { ...event, match_status: "new", matched_event_id: null, is_duplicate: false };
}

/**
 * Collapse duplicates inside a single fetch batch (e.g. AI scrape emitting
 * the same show twice with midnight vs offset start times).
 * Keeps the higher-preference row; marks others as is_duplicate.
 */
export function dedupeWithinBatch(events: DedupInput[]): MatchedPartnerEvent[] {
	const winners = new Map<string, { event: DedupInput; index: number }>();
	const loserIndexes = new Set<number>();

	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const titleKey = normalizeTitle(event.title);
		const ticketKey = normalizeTicket(event.ticket_url);
		// Group by title + day (+ ticket identity when present).
		// Day is always part of the key so multi-date series that share one
		// booking URL (Jester King goat walks) are not collapsed.
		// Distinct SmartSeat itemNumbers remain distinct via ticketKey.
		const key = ticketKey
			? `ticket:${titleKey}|${ticketKey}|${dayKey(event.starts_at)}`
			: `day:${titleKey}|${dayKey(event.starts_at)}`;

		// Collapse only true near-duplicates (same ticket identity OR same show window).
		let matchedKey: string | null = null;
		for (const [wKey, winner] of winners) {
			const sameTitle = normalizeTitle(winner.event.title) === titleKey;
			if (!sameTitle) continue;
			const sameTicket =
				Boolean(ticketKey) &&
				normalizeTicket(winner.event.ticket_url) === ticketKey;
			// Same identity ticket only collapses when the start is in the same show window
			// (clock drift). Shared series booking URLs across different days stay distinct.
			if (sameTicket && isSameShowWindow(winner.event.starts_at, event.starts_at)) {
				matchedKey = wKey;
				break;
			}
			if (!ticketKey && isSameShowWindow(winner.event.starts_at, event.starts_at)) {
				matchedKey = wKey;
				break;
			}
			// Distinct ticket identities (different itemNumbers) are different performances.
			if (ticketKey && normalizeTicket(winner.event.ticket_url) && !sameTicket) {
				continue;
			}
			if (isSameShowWindow(winner.event.starts_at, event.starts_at)) {
				matchedKey = wKey;
				break;
			}
		}

		const groupKey = matchedKey ?? key;
		const existing = winners.get(groupKey);
		if (!existing) {
			winners.set(groupKey, { event, index: i });
			continue;
		}

		const keepNew =
			duplicatePreferenceScore(event) > duplicatePreferenceScore(existing.event);
		if (keepNew) {
			loserIndexes.add(existing.index);
			winners.set(groupKey, { event, index: i });
		} else {
			loserIndexes.add(i);
		}
	}

	const winnerByIndex = new Map(
		[...winners.values()].map((w) => [w.index, w.event] as const),
	);

	return events.map((event, index): MatchedPartnerEvent => {
		if (loserIndexes.has(index)) {
			// Point at a winner with same title if possible
			const winner = [...winners.values()].find(
				(w) =>
					normalizeTitle(w.event.title) === normalizeTitle(event.title) &&
					(normalizeTicket(w.event.ticket_url) === normalizeTicket(event.ticket_url) ||
						isSameShowWindow(w.event.starts_at, event.starts_at)),
			);
			return {
				...event,
				match_status: "matched_existing",
				matched_event_id: null,
				is_duplicate: true,
				duplicate_of: winner ? `batch:${winner.index}` : "batch",
			};
		}
		if (winnerByIndex.has(index)) {
			return {
				...event,
				match_status: "new",
				matched_event_id: null,
				is_duplicate: false,
			};
		}
		return {
			...event,
			match_status: "new",
			matched_event_id: null,
			is_duplicate: false,
		};
	});
}

async function loadExistingForVenue(
	supabase: SupabaseClient,
	venueId: string,
): Promise<ExistingEvent[]> {
	const [{ data: events, error: eventsError }, { data: ingested, error: ingestedError }] =
		await Promise.all([
			supabase
				.from("events")
				.select("id, title, starts_at, ticket_url, source_event_id, fingerprint")
				.eq("venue_id", venueId)
				.is("deleted_at", null)
				.neq("status", "archived"),
			supabase
				.from("ingested_events")
				.select("id, raw_title, parsed_starts_at, source_event_id, fingerprint, raw_payload")
				.eq("venue_id", venueId)
				.in("review_status", ["pending", "approved"]),
		]);

	if (eventsError) {
		throw new Error(`Failed to load existing events for venue ${venueId}: ${eventsError.message}`);
	}
	if (ingestedError) {
		throw new Error(
			`Failed to load pending ingested_events for venue ${venueId}: ${ingestedError.message}`,
		);
	}

	const published: ExistingEvent[] = (events ?? []).map((row) => ({
		id: row.id as string,
		title: row.title as string,
		starts_at: row.starts_at as string,
		ticket_url: (row.ticket_url as string | null) ?? null,
		source_event_id: (row.source_event_id as string | null) ?? null,
		fingerprint: (row.fingerprint as string | null) ?? null,
		kind: "event" as const,
	}));

	const staged: ExistingEvent[] = (ingested ?? []).map((row) => {
		const payload = (row.raw_payload ?? {}) as { ticket_url?: string | null };
		return {
			id: row.id as string,
			title: row.raw_title as string,
			starts_at: (row.parsed_starts_at as string) ?? "",
			ticket_url: payload.ticket_url ?? null,
			source_event_id: (row.source_event_id as string | null) ?? null,
			fingerprint: (row.fingerprint as string | null) ?? null,
			kind: "ingested" as const,
		};
	});

	return [...published, ...staged];
}

/**
 * Dedup order:
 * 1. Within-batch collapse (AI double emits, exact fingerprint)
 * 2. source_event_id (partner UID)
 * 3. exact music duplicate (title + same-show window or ticket)
 * 4. fingerprint
 * 5. fuzzy title + same-show window
 * 6. Against published events AND pending/approved ingested_events
 */
export async function matchPartnerEvents(
	supabase: SupabaseClient,
	venueId: string,
	events: DedupInput[],
): Promise<MatchedPartnerEvent[]> {
	// 1) Collapse batch-internal duplicates first
	const batchDeduped = dedupeWithinBatch(events);
	const survivors = batchDeduped.filter((e) => !e.is_duplicate);
	const dropped = batchDeduped.filter((e) => e.is_duplicate);

	const existing = await loadExistingForVenue(supabase, venueId);

	const matchedSurvivors = survivors.map((event): MatchedPartnerEvent => {
		const stable = matchByStableId(existing, event);
		if (stable) {
			return {
				...event,
				match_status: stable.status,
				matched_event_id: stable.id,
				is_duplicate: true,
				duplicate_of: stable.id,
			};
		}
		const fuzzy = matchByFuzzy(existing, event);
		// needs_review is still staged; only matched_existing is a hard skip
		if (fuzzy.match_status === "matched_existing") {
			return { ...fuzzy, is_duplicate: true, duplicate_of: fuzzy.matched_event_id };
		}
		return { ...fuzzy, is_duplicate: false };
	});

	return [...matchedSurvivors, ...dropped];
}

/**
 * Collapse already-staged pending rows for a venue (or all venues).
 * Rejects lower-preference duplicates, keeps the best pending row per show.
 * Returns counts.
 */
export async function collapsePendingIngestedDuplicates(
	supabase: SupabaseClient,
	venueId?: string,
): Promise<{ kept: number; rejected: number }> {
	let query = supabase
		.from("ingested_events")
		.select("id, venue_id, raw_title, parsed_starts_at, fingerprint, raw_payload, created_at")
		.eq("review_status", "pending")
		.order("created_at", { ascending: true });

	if (venueId) query = query.eq("venue_id", venueId);

	const { data, error } = await query;
	if (error) throw new Error(`Failed to load pending for collapse: ${error.message}`);

	type Row = {
		id: string;
		venue_id: string;
		raw_title: string;
		parsed_starts_at: string | null;
		fingerprint: string | null;
		raw_payload: {
			ticket_url?: string | null;
			image_url?: string | null;
			confidence?: number;
			description?: string | null;
		} | null;
		created_at: string;
	};

	const rows = (data ?? []) as Row[];
	const byVenue = new Map<string, Row[]>();
	for (const row of rows) {
		const list = byVenue.get(row.venue_id) ?? [];
		list.push(row);
		byVenue.set(row.venue_id, list);
	}

	const rejectIds: string[] = [];
	let kept = 0;

	for (const [, venueRows] of byVenue) {
		const winners: Row[] = [];
		for (const row of venueRows) {
			const starts = row.parsed_starts_at ?? "";
			const title = normalizeTitle(row.raw_title);
			const ticket = normalizeTicket(row.raw_payload?.ticket_url);
			const score = duplicatePreferenceScore({
				starts_at: starts,
				ticket_url: row.raw_payload?.ticket_url,
				image_url: row.raw_payload?.image_url,
				confidence: row.raw_payload?.confidence,
				description: row.raw_payload?.description,
			});

			const matchIdx = winners.findIndex((w) => {
				if (w.fingerprint && row.fingerprint && w.fingerprint === row.fingerprint) return true;
				const sameTitle = normalizeTitle(w.raw_title) === title;
				if (!sameTitle) return false;
				const sameTicket =
					ticket &&
					normalizeTicket(w.raw_payload?.ticket_url) === ticket;
				if (sameTicket) return true;
				return isSameShowWindow(w.parsed_starts_at ?? "", starts);
			});

			if (matchIdx === -1) {
				winners.push(row);
				kept++;
				continue;
			}

			const winner = winners[matchIdx];
			const winnerScore = duplicatePreferenceScore({
				starts_at: winner.parsed_starts_at ?? "",
				ticket_url: winner.raw_payload?.ticket_url,
				image_url: winner.raw_payload?.image_url,
				confidence: winner.raw_payload?.confidence,
				description: winner.raw_payload?.description,
			});

			if (score > winnerScore) {
				rejectIds.push(winner.id);
				winners[matchIdx] = row;
			} else {
				rejectIds.push(row.id);
			}
		}
	}

	if (rejectIds.length > 0) {
		const chunkSize = 100;
		const reviewedAt = new Date().toISOString();
		for (let i = 0; i < rejectIds.length; i += chunkSize) {
			const chunk = rejectIds.slice(i, i + chunkSize);
			const { error: updError } = await supabase
				.from("ingested_events")
				.update({ review_status: "rejected", reviewed_at: reviewedAt })
				.in("id", chunk);
			if (updError) throw new Error(`Failed to reject duplicates: ${updError.message}`);
		}
	}

	return { kept, rejected: rejectIds.length };
}
