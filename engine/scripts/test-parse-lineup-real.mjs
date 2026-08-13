import { parseLineupFromTitle } from "../src/lib/parse-lineup.ts";

const cases = [
	{
		input: "Live Music: Franz Ferdinand w/ Sunday Mourners",
		want: ["Franz Ferdinand|headliner", "Sunday Mourners|support"],
	},
	{
		input: "Antone's 51st Anniversary: Bob Schneider (FULL BAND) w/ John Primer",
		want: ["Bob Schneider|headliner", "John Primer|support"],
	},
	{
		input: "An Evening with Christine Albert & Special Guests",
		wantHead: "Christine Albert",
		wantLen: 1,
	},
	{
		input: "Channel Tres - The Enigma Tour",
		wantHead: "Channel Tres",
	},
];

let failed = 0;
for (const c of cases) {
	const slots = parseLineupFromTitle(c.input);
	const got = slots.map((s) => `${s.name}|${s.role}`);
	if (c.want) {
		const ok = JSON.stringify(got) === JSON.stringify(c.want);
		if (!ok) {
			console.error("FAIL", c.input, got);
			failed++;
		} else console.log("OK", c.input);
	} else {
		const ok =
			slots[0]?.name === c.wantHead && (c.wantLen == null || slots.length === c.wantLen);
		if (!ok) {
			console.error("FAIL", c.input, got);
			failed++;
		} else console.log("OK", c.input, "→", slots[0].name);
	}
}
process.exit(failed ? 1 : 0);
