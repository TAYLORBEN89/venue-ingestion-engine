/**
 * @deprecated Do not use — product decision: keep full banners at 3:2 display
 * aspect (CSS object-cover), do not crop images in half.
 * See fix-germania-uncrop-images.mjs to restore full posters.
 *
 * Crop Germania event posters to the RIGHT half only.
 * Source banners are wide (venue + art); the useful art is on the right.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "crypto";
import sharp from "sharp";

const env = Object.fromEntries(
	readFileSync("./.dev.vars", "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = "event-media";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

function fetchable(url) {
	if (!url) return null;
	if (/rackcdn\.com/i.test(url)) return url.replace(/^https:\/\//i, "http://");
	return url;
}

async function download(url) {
	const u = fetchable(url);
	const r = await fetch(u, {
		headers: { "User-Agent": UA, Accept: "image/*,*/*" },
		redirect: "follow",
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return Buffer.from(await r.arrayBuffer());
}

/** Keep right half of image. */
async function cropRightHalf(buf) {
	const img = sharp(buf);
	const meta = await img.metadata();
	const w = meta.width || 0;
	const h = meta.height || 0;
	if (w < 4 || h < 4) throw new Error(`bad dimensions ${w}x${h}`);

	const half = Math.floor(w / 2);
	const left = w - half; // right half
	const out = await sharp(buf)
		.extract({ left, top: 0, width: half, height: h })
		.jpeg({ quality: 88, mozjpeg: true })
		.toBuffer();

	return { out, from: `${w}x${h}`, to: `${half}x${h}`, left };
}

async function upload(siteId, title, jpegBuf) {
	const path = `${siteId}/germania/crop-right/${randomUUID()}.jpg`;
	const { error } = await sb.storage.from(BUCKET).upload(path, jpegBuf, {
		contentType: "image/jpeg",
		upsert: false,
	});
	if (error) throw new Error(error.message);
	const {
		data: { publicUrl },
	} = sb.storage.from(BUCKET).getPublicUrl(path);
	await sb.from("media").insert({
		site_id: siteId,
		storage_path: publicUrl,
		alt_text: `${title} (right crop)`,
	});
	return publicUrl;
}

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id")
	.eq("site_id", site.id)
	.eq("slug", "germania-insurance-amphitheater")
	.single();

const { data: rows, error } = await sb
	.from("ingested_events")
	.select("id, raw_title, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending");

if (error) throw new Error(error.message);
console.log(`Germania pending: ${rows?.length ?? 0}`);

let ok = 0;
let fail = 0;

for (const row of rows ?? []) {
	const payload = row.raw_payload || {};
	// Prefer original full banner if we still have it; else current image_url
	const src = payload.source_image_url || payload.image_url;
	if (!src) {
		console.log("· no image", row.raw_title);
		fail++;
		continue;
	}

	// Skip if already right-cropped
	if (payload.image_crop === "right-half" && payload.image_url) {
		console.log("· already cropped", row.raw_title.slice(0, 35));
		ok++;
		continue;
	}

	try {
		console.log("→", row.raw_title.slice(0, 40));
		const buf = await download(src);
		const { out, from, to, left } = await cropRightHalf(buf);
		const publicUrl = await upload(site.id, row.raw_title, out);

		const next = {
			...payload,
			image_url: publicUrl,
			source_image_url: payload.source_image_url || src,
			image_crop: "right-half",
			image_crop_meta: { from, to, keep: "right", left },
		};

		const { error: upErr } = await sb
			.from("ingested_events")
			.update({ raw_payload: next })
			.eq("id", row.id);
		if (upErr) throw new Error(upErr.message);

		console.log(`  ✓ ${from} → ${to} right half`);
		ok++;
	} catch (e) {
		console.log("  ✗", e.message);
		fail++;
	}
}

console.log(`\nDone: ${ok} cropped, ${fail} failed`);
console.log("Refresh → https://events-platform-admin.ben-745.workers.dev/ingestion");
