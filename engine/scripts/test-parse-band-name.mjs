import { extractBandName, PARSE_BAND_NAME_FIXTURES } from "../src/lib/parse-band-name.ts";

let failed = 0;
for (const { input, expected } of PARSE_BAND_NAME_FIXTURES) {
	const got = extractBandName(input);
	if (got !== expected) {
		failed++;
		console.log("FAIL");
		console.log("  input:    ", input);
		console.log("  expected: ", expected);
		console.log("  got:      ", got);
	}
}

if (failed > 0) {
	console.error(`\n${failed}/${PARSE_BAND_NAME_FIXTURES.length} fixtures failed`);
	process.exit(1);
}

console.log(`All ${PARSE_BAND_NAME_FIXTURES.length} parse-band-name fixtures passed.`);