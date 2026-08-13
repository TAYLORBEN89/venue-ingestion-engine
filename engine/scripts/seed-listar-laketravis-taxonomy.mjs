/**
 * Seed Lake Travis venue categories + regions from Listar / WP REST.
 *
 *   node apps/ingestion/scripts/seed-listar-laketravis-taxonomy.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const ORIGIN = "https://laketravis.com";
const SITE_SLUG = "laketravis";

function loadEnv() {
	const env = { ...process.env };
	for (const f of [
		path.join(ROOT, "apps/ingestion/.dev.vars"),
		path.join(ROOT, "apps/admin/.env.local"),
	]) {
		if (!fs.existsSync(f)) continue;
		for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
			if (!line || line.startsWith("#") || !line.includes("=")) continue;
			const i = line.indexOf("=");
			const k = line.slice(0, i).trim();
			let v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
			if (k && env[k] === undefined) env[k] = v;
		}
	}
	return env;
}

function stripHtml(s) {
	return String(s || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchJson(url) {
	const res = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 events-platform-lt-seed", Accept: "application/json" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}

async function fetchAllPages(base) {
	const out = [];
	for (let page = 1; page <= 50; page++) {
		const url = `${base}${base.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 events-platform-lt-seed", Accept: "application/json" },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
		const batch = await res.json();
		if (!Array.isArray(batch) || !batch.length) break;
		out.push(...batch);
		const totalPages = Number(res.headers.get("x-wp-totalpages") || 1);
		if (page >= totalPages) break;
	}
	return out;
}

const env = loadEnv();
const sb = createClient(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: site, error: sErr } = await sb.from("sites").select("id,slug,name").eq("slug", SITE_SLUG).single();
if (sErr || !site) throw new Error(sErr?.message || "no site");
console.log("Site", site.name, site.id);

// Categories from Listar (hierarchical tree)
const listarCats = await fetchJson(`${ORIGIN}/wp-json/listar/v1/category/list`);
const flatCats = [];
function walk(nodes, parentSlug = null) {
	for (const n of nodes || []) {
		const slug = n.slug;
		if (!slug) continue;
		flatCats.push({
			slug,
			name: stripHtml(n.name),
			description: stripHtml(n.description) || null,
			parent_slug: parentSlug,
			term_id: n.term_id,
		});
		if (Array.isArray(n.children) && n.children.length) walk(n.children, slug);
		// some payloads use nested differently
	}
}
walk(listarCats.data || listarCats);

// If listar is flat only
if (!flatCats.length && Array.isArray(listarCats.data)) {
	for (const n of listarCats.data) {
		flatCats.push({
			slug: n.slug,
			name: stripHtml(n.name),
			description: stripHtml(n.description) || null,
			parent_slug: n.parent ? null : null, // resolve below via parent id
			parent_id_wp: n.parent || 0,
			term_id: n.term_id,
		});
	}
	const byTerm = Object.fromEntries(flatCats.map((c) => [c.term_id, c]));
	for (const c of flatCats) {
		if (c.parent_id_wp) {
			const p = byTerm[c.parent_id_wp];
			c.parent_slug = p?.slug || null;
		}
	}
}

// Also pull WP REST job-categories for completeness
const wpCats = await fetchAllPages(`${ORIGIN}/wp-json/wp/v2/job-categories`);
const bySlug = new Map(flatCats.map((c) => [c.slug, c]));
for (const w of wpCats) {
	if (!bySlug.has(w.slug)) {
		bySlug.set(w.slug, {
			slug: w.slug,
			name: stripHtml(w.name),
			description: stripHtml(w.description) || null,
			parent_slug: null,
			term_id: w.id,
		});
	}
}
const cats = [...bySlug.values()];
console.log("Categories to seed:", cats.length);

// Insert categories in parent-first passes
const catIdBySlug = {};
let catCreated = 0;
let catUpdated = 0;
for (let pass = 0; pass < 5; pass++) {
	let progressed = false;
	for (const c of cats) {
		if (catIdBySlug[c.slug]) continue;
		if (c.parent_slug && !catIdBySlug[c.parent_slug]) continue;
		const parent_id = c.parent_slug ? catIdBySlug[c.parent_slug] : null;
		const { data: existing } = await sb
			.from("categories")
			.select("id")
			.eq("site_id", site.id)
			.eq("kind", "venue")
			.eq("slug", c.slug)
			.maybeSingle();
		if (existing) {
			await sb
				.from("categories")
				.update({
					name: c.name,
					description: c.description,
					parent_id,
				})
				.eq("id", existing.id);
			catIdBySlug[c.slug] = existing.id;
			catUpdated++;
		} else {
			const { data: row, error } = await sb
				.from("categories")
				.insert({
					site_id: site.id,
					kind: "venue",
					slug: c.slug,
					name: c.name,
					description: c.description,
					parent_id,
				})
				.select("id")
				.single();
			if (error) {
				console.warn("cat fail", c.slug, error.message);
				continue;
			}
			catIdBySlug[c.slug] = row.id;
			catCreated++;
		}
		progressed = true;
	}
	if (!progressed) break;
}
console.log(`Categories created=${catCreated} updated=${catUpdated} mapped=${Object.keys(catIdBySlug).length}`);

// Regions from WP
const wpRegions = await fetchAllPages(`${ORIGIN}/wp-json/wp/v2/job_listing_region`);
console.log("Regions from WP:", wpRegions.length);
let regCreated = 0;
let regUpdated = 0;
for (const r of wpRegions) {
	const slug = r.slug;
	const name = stripHtml(r.name);
	const { data: existing } = await sb
		.from("regions")
		.select("id")
		.eq("site_id", site.id)
		.eq("slug", slug)
		.maybeSingle();
	if (existing) {
		await sb.from("regions").update({ name }).eq("id", existing.id);
		regUpdated++;
	} else {
		const { error } = await sb.from("regions").insert({ site_id: site.id, slug, name });
		if (error) console.warn("region fail", slug, error.message);
		else regCreated++;
	}
}
console.log(`Regions created=${regCreated} updated=${regUpdated}`);

const out = path.join(ROOT, "tmp-enhance/laketravis/taxonomy-seed.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
	out,
	JSON.stringify(
		{
			site: site.slug,
			categories: Object.keys(catIdBySlug).length,
			regions: wpRegions.length,
			catSlugs: Object.keys(catIdBySlug).sort(),
		},
		null,
		2,
	),
);
console.log("wrote", out);
console.log("Done.");
