import { toPartnerEvent, type PartnerEvent } from "../normalize";

interface ParsedIcalField {
	name: string;
	params: Record<string, string>;
	value: string;
}

interface VEventBlock {
	fields: ParsedIcalField[];
}

function unfoldLines(text: string): string[] {
	const raw = text.replace(/\r\n/g, "\n").split("\n");
	const lines: string[] = [];
	for (const line of raw) {
		if (line.startsWith(" ") || line.startsWith("\t")) {
			lines[lines.length - 1] += line.slice(1);
		} else {
			lines.push(line);
		}
	}
	return lines;
}

function parseField(line: string): ParsedIcalField | null {
	const colon = line.indexOf(":");
	if (colon < 0) return null;
	const left = line.slice(0, colon);
	const value = line.slice(colon + 1).trim();
	const parts = left.split(";");
	const name = parts[0].toUpperCase();
	const params: Record<string, string> = {};
	for (const part of parts.slice(1)) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
	}
	return { name, params, value };
}

function extractVevents(text: string): VEventBlock[] {
	const lines = unfoldLines(text);
	const blocks: VEventBlock[] = [];
	let current: ParsedIcalField[] | null = null;

	for (const line of lines) {
		if (line === "BEGIN:VEVENT") {
			current = [];
			continue;
		}
		if (line === "END:VEVENT") {
			if (current) blocks.push({ fields: current });
			current = null;
			continue;
		}
		if (!current) continue;
		const field = parseField(line);
		if (field) current.push(field);
	}
	return blocks;
}

function fieldValue(block: VEventBlock, name: string): string | null {
	const field = block.fields.find((f) => f.name === name);
	return field?.value ?? null;
}

function field(block: VEventBlock, name: string): ParsedIcalField | null {
	return block.fields.find((f) => f.name === name) ?? null;
}

function parseIcalDate(field: ParsedIcalField | null): string | null {
	if (!field) return null;
	const raw = field.value;
	if (field.params.VALUE === "DATE" || raw.length === 8) {
		const y = raw.slice(0, 4);
		const m = raw.slice(4, 6);
		const d = raw.slice(6, 8);
		return `${y}-${m}-${d}T00:00:00.000Z`;
	}
	if (raw.endsWith("Z")) {
		const y = raw.slice(0, 4);
		const m = raw.slice(4, 6);
		const d = raw.slice(6, 8);
		const hh = raw.slice(9, 11);
		const mm = raw.slice(11, 13);
		const ss = raw.slice(13, 15) || "00";
		return `${y}-${m}-${d}T${hh}:${mm}:${ss}.000Z`;
	}
	// Floating local time without TZID — treat as UTC for now; curators can fix on review.
	const y = raw.slice(0, 4);
	const m = raw.slice(4, 6);
	const d = raw.slice(6, 8);
	const hh = raw.slice(9, 11);
	const mm = raw.slice(11, 13);
	const ss = raw.slice(13, 15) || "00";
	return `${y}-${m}-${d}T${hh}:${mm}:${ss}.000Z`;
}

function unescapeIcalText(value: string): string {
	return value.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

export function parseIcalFeed(
	icsText: string,
	context: {
		venueName: string;
		address: string | null;
		sourceUrl: string;
		sourcePartner: string;
	},
): PartnerEvent[] {
	const events: PartnerEvent[] = [];
	for (const block of extractVevents(icsText)) {
		const title = fieldValue(block, "SUMMARY");
		const startsAt = parseIcalDate(field(block, "DTSTART"));
		if (!title || !startsAt) continue;

		const uid = fieldValue(block, "UID");
		const description = fieldValue(block, "DESCRIPTION");
		const url = fieldValue(block, "URL");
		const endsAt = parseIcalDate(field(block, "DTEND"));
		const location = fieldValue(block, "LOCATION");

		events.push(
			toPartnerEvent({
				title: unescapeIcalText(title),
				starts_at: startsAt,
				ends_at: endsAt,
				venue_name: context.venueName,
				address: location ?? context.address,
				description: description ? unescapeIcalText(description) : null,
				source_url: url ?? context.sourceUrl,
				source_partner: context.sourcePartner,
				source_event_id: uid,
				raw_date_text: field(block, "DTSTART")?.value ?? startsAt,
				ticket_url: url,
				confidence: 1,
			}),
		);
	}
	return events;
}