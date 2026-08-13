/** Convert a wall-clock datetime in an IANA timezone to UTC ISO 8601. */
export function localWallTimeToUtcIso(local: string, timeZone: string): string {
	const [datePart, timePart] = local.split(" ");
	if (!datePart || !timePart) {
		throw new Error(`Invalid local datetime: ${local}`);
	}

	const [year, month, day] = datePart.split("-").map(Number);
	const [hour, minute, second = 0] = timePart.split(":").map(Number);
	const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, guess);
	return new Date(guess.getTime() - offsetMinutes * 60_000).toISOString();
}

function getTimeZoneOffsetMinutes(timeZone: string, at: Date): number {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		})
			.formatToParts(at)
			.filter((p) => p.type !== "literal")
			.map((p) => [p.type, p.value]),
	);

	// Some engines emit hour "24" for midnight — normalize before Date.UTC.
	let hour = Number(parts.hour);
	if (hour === 24) hour = 0;
	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		hour,
		Number(parts.minute),
		Number(parts.second),
	);
	return (asUtc - at.getTime()) / 60_000;
}