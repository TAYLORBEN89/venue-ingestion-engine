/**
 * Build venues/<slug>/{source.json,README.md} from catalog.json.
 * Run from repo root: node venues/_generate.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "examples", "venues", "catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const outRoot = join(root, "venues");

const RELATED = {
	"poodie-s-hilltop-roadhouse": [
		"engine/scripts/pilot-poodies.mjs",
		"venues/poodie-s-hilltop-roadhouse/scrape-poodies-calendar.mjs",
	],
	"germania-insurance-amphitheater": [
		"engine/scripts/pilot-germania-amp.mjs",
		"engine/scripts/smoke-germania-amp.mjs",
		"engine/scripts/fix-germania-images.mjs",
	],
	"circuit-of-the-americas": [
		"engine/scripts/pilot-cota.mjs",
		"engine/scripts/curate-cota.mjs",
		"engine/scripts/stage-cota-local.mjs",
	],
	"doc-s-bar-and-grill": [
		"engine/scripts/pilot-docs-bar.mjs",
		"engine/scripts/smoke-spotapps-docs.mjs",
	],
	"speakeasy": [
		"engine/scripts/pilot-speakeasy.mjs",
		"engine/scripts/smoke-eventon-speakeasy.mjs",
	],
	"san-jac-saloon": [
		"engine/scripts/pilot-san-jac.mjs",
		"engine/scripts/smoke-san-jac-ics.mjs",
		"engine/scripts/smoke-san-jac-htmlembed.mjs",
	],
	"acl-live": [
		"engine/scripts/pilot-acl-events-full.mjs",
		"engine/scripts/pilot-acl-3ten-full-calendar.mjs",
		"engine/scripts/backfill-acl-ticket-urls.mjs",
	],
	"vulcan-gas-company": [
		"engine/scripts/pilot-vulcan.mjs",
		"engine/scripts/pilot-vulcan-stage.mjs",
	],
	"cactus-cafe": ["engine/scripts/pilot-batch-round3.mjs", "engine/scripts/fix-cactus-full.mjs"],
	"friends-bar": ["engine/scripts/pilot-batch-new.mjs", "engine/scripts/fix-friends-full.mjs"],
	"coupland-dancehall": ["engine/scripts/pilot-batch-round3.mjs", "engine/scripts/fix-coupland-images.mjs"],
	"moontower-saloon": ["engine/scripts/pilot-moontower.mjs", "engine/scripts/fix-moontower-images.mjs"],
	"the-historic-scoot-inn": ["engine/scripts/repilot-venues.mjs", "engine/scripts/fix-scoot-descriptions.mjs"],
	"the-saxon-pub": ["engine/scripts/saxon-full-calendar.mjs", "engine/scripts/repilot-venues.mjs"],
	"the-long-center": ["engine/scripts/pilot-long-center-full.mjs", "engine/scripts/pilot-batch-round4.mjs"],
};

const ALSO_NAMES = {
	"the-moody-center": "Moody Center",
	"moody-amphitheater-austin": "Moody Amphitheater",
	"meanwhile-brewing-company": "Meanwhile Brewing Company",
	"hotel-vegas": "Hotel Vegas",
	"stubb-s-bbq": "Stubb's BBQ",
	"antones-nightclub": "Antone's Nightclub",
	"buck-s-backyard": "Buck's Backyard",
};

const ALSO_SCRIPTS = {
	"the-moody-center": ["engine/scripts/probe-moody-center-html.mjs", "engine/scripts/probe-moody-images.mjs"],
	"moody-amphitheater-austin": [
		"engine/scripts/probe-moody-amp.mjs",
		"engine/scripts/probe-moody-amp-full.mjs",
		"engine/scripts/probe-moody-amp-deep.mjs",
	],
	"meanwhile-brewing-company": [
		"engine/scripts/probe-meanwhile-months.mjs",
		"engine/scripts/probe-hotel-meanwhile.mjs",
	],
	"hotel-vegas": ["engine/scripts/probe-hotel-detail.mjs", "engine/scripts/probe-mec-hotel.mjs"],
	"stubb-s-bbq": ["engine/scripts/probe-stubbs.mjs", "engine/scripts/test-stubbs-discovery.mjs"],
	"antones-nightclub": ["engine/scripts/inspect-antones.mjs", "engine/scripts/probe-antones-api.mjs"],
	"buck-s-backyard": ["engine/scripts/lib/pilot-venue-filters.mjs"],
};

function writeVenue(dir, source, readme) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "source.json"), `${JSON.stringify(source, null, "\t")}\n`);
	writeFileSync(join(dir, "README.md"), readme);
}

function dedicatedReadme(v, related) {
	const website = v.website_url ? `\n| Website | ${v.website_url} |` : "";
	const relatedList = related.map((s) => `- \`${s}\``).join("\n");
	const scriptName = (v.script ?? "").replace("engine/scripts/", "");
	const probe = scriptName.startsWith("pilot-")
		? `node scripts/${scriptName} --probe-only`
		: `node scripts/${scriptName}`;
	return `# ${v.name}

| | |
|--|--|
| Slug | \`${v.slug}\` |
| Platform | \`${v.platform_type}\` |
| Calendar | ${v.calendar_url} |${website}

## Run

From \`engine/\` (needs \`.dev.vars\` and a \`venues\` row with this slug):

\`\`\`bash
cd engine
${probe}
\`\`\`

Generic ingest after the source is wired:

\`\`\`bash
node scripts/ingest-venue.mjs ${v.slug}
\`\`\`

## Scripts

${relatedList}

Adapter family: see [docs/ADAPTERS.md](../../docs/ADAPTERS.md). Catalog: [venues/catalog.json](../catalog.json).
`;
}

function alsoReadme(slug, name, notes, scripts) {
	const relatedList = scripts.map((s) => `- \`${s}\``).join("\n");
	return `# ${name}

| | |
|--|--|
| Slug | \`${slug}\` |
| Status | Completed via generic pipeline (no dedicated ingest script) |

${notes}

## Scripts

${relatedList}

See [docs/VENUES.md](../../docs/VENUES.md).
`;
}

mkdirSync(outRoot, { recursive: true });

const packaged = [];

for (const v of catalog.venues) {
	const dir = join(outRoot, v.slug);
	const related = RELATED[v.slug] ?? (v.script ? [v.script] : []);
	const source = {
		slug: v.slug,
		name: v.name,
		calendar_url: v.calendar_url,
		website_url: v.website_url ?? null,
		platform_type: v.platform_type,
		timezone: catalog.timezone,
		script: v.script,
		related_scripts: related,
	};
	writeVenue(dir, source, dedicatedReadme(v, related));
	packaged.push({ slug: v.slug, name: v.name, kind: "dedicated" });
}

for (const extra of catalog.also_piloted_via_generic_pipeline) {
	const dir = join(outRoot, extra.slug);
	const name = ALSO_NAMES[extra.slug] ?? extra.slug;
	const scripts = ALSO_SCRIPTS[extra.slug] ?? [];
	const source = {
		slug: extra.slug,
		name,
		calendar_url: null,
		website_url: null,
		platform_type: null,
		timezone: catalog.timezone,
		script: null,
		related_scripts: scripts,
		notes: extra.notes,
	};
	writeVenue(dir, source, alsoReadme(extra.slug, name, extra.notes, scripts));
	packaged.push({ slug: extra.slug, name, kind: "generic" });
}

const poodiesSrc = join(root, "examples", "venues", "poodies-hilltop");
const poodiesDst = join(outRoot, "poodie-s-hilltop-roadhouse");
if (existsSync(poodiesSrc)) {
	for (const file of [
		"august-2026-slots.json",
		"poodies-build-drafts.mjs",
		"poodies-check-artists.mjs",
		"poodies-stage-queue.mjs",
		"rules.json",
		"scrape-poodies-calendar.mjs",
		"slots-merged.json",
	]) {
		cpSync(join(poodiesSrc, file), join(poodiesDst, file));
	}
}

const catalogOut = {
	...catalog,
	note: "Canonical venue list. Each slug has venues/<slug>/source.json + README.md. Run scripts from engine/.",
	venues: catalog.venues.map((v) => ({
		...v,
		packet: v.slug === "poodie-s-hilltop-roadhouse" ? "venues/poodie-s-hilltop-roadhouse/" : `venues/${v.slug}/`,
	})),
};
writeFileSync(join(outRoot, "catalog.json"), `${JSON.stringify(catalogOut, null, "\t")}\n`);
writeFileSync(join(outRoot, "index.json"), `${JSON.stringify(packaged, null, "\t")}\n`);

console.log(`Wrote ${packaged.length} venue folders under venues/`);
