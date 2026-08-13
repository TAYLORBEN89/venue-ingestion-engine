/**
 * Re-host Germania rackcdn posters on Supabase Storage (HTTPS).
 *
 * Why images failed:
 * - Source CDN is Cloud Files rackcdn with invalid TLS cert
 *   (ERR_TLS_CERT_ALTNAME_INVALID on https://)
 * - http:// works, but admin is HTTPS → browser blocks mixed content
 * Fix: download over http, upload to event-media bucket, store public HTTPS URL
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

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

function toFetchable(url) {
	if (!url) return null;
	// rackcdn only serves valid certs on http for this host
	if (/rackcdn\.com/i.test(url)) return url.replace(/^https:\/\//i, "http://");
	return url;
}

async function rehost(siteId, altText, imageUrl) {
	const fetchUrl = toFetchable(imageUrl);
	if (!fetchUrl) return null;

	const response = await fetch(fetchUrl, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
			Accept: "image/*,*/*",
		},
		redirect: "follow",
	});
	if (!response.ok) {
		console.log("  fetch fail", response.status, fetchUrl.slice(0, 80));
		return null;
	}
	const contentType = response.headers.get("content-type") ?? "image/jpeg";
	if (!contentType.startsWith("image/")) {
		console.log("  not image", contentType);
		return null;
	}
	const ext = contentType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ?? "jpg";
	const bytes = await response.arrayBuffer();
	const path = `${siteId}/germania/${randomUUID()}.${ext}`;

	const { error: uploadError } = await sb.storage
		.from(BUCKET)
		.upload(path, bytes, { contentType: contentType.startsWith("image/") ? contentType : "image/jpeg", upsert: false });
	if (uploadError) {
		console.log("  upload fail", uploadError.message);
		return null;
	}

	const {
		data: { publicUrl },
	} = sb.storage.from(BUCKET).getPublicUrl(path);

	// Optional media row (non-fatal)
	await sb.from("media").insert({
		site_id: siteId,
		storage_path: publicUrl,
		alt_text: altText,
	});

	return publicUrl;
}

const { data: site } = await sb.from("sites").select("id").eq("slug", "heyaustin").single();
const { data: venue } = await sb
	.from("venues")
	.select("id, name")
	.eq("site_id", site.id)
	.eq("slug", "germania-insurance-amphitheater")
	.single();

const { data: rows, error } = await sb
	.from("ingested_events")
	.select("id, raw_title, raw_payload")
	.eq("venue_id", venue.id)
	.eq("review_status", "pending");

if (error) throw new Error(error.message);
console.log(`Pending Germania rows: ${rows?.length ?? 0}`);

let ok = 0;
let fail = 0;
for (const row of rows ?? []) {
	const payload = row.raw_payload || {};
	const src = payload.image_url || payload.artist_image_url;
	if (!src) {
		console.log("· no image", row.raw_title);
		fail++;
		continue;
	}
	// Already re-hosted?
	if (/supabase\.co\/storage/i.test(src)) {
		console.log("· already hosted", row.raw_title.slice(0, 30));
		ok++;
		continue;
	}

	console.log("→", row.raw_title.slice(0, 40));
	const publicUrl = await rehost(site.id, row.raw_title, src);
	if (!publicUrl) {
		fail++;
		continue;
	}

	const next = {
		...payload,
		image_url: publicUrl,
		source_image_url: src, // keep original for reference
	};
	// also rehost artist photo if present and different
	if (payload.artist_image_url && !/supabase\.co\/storage/i.test(payload.artist_image_url)) {
		const artistUrl = await rehost(site.id, `${row.raw_title} artist`, payload.artist_image_url);
		if (artistUrl) next.artist_image_url = artistUrl;
	}

	const { error: upErr } = await sb
		.from("ingested_events")
		.update({ raw_payload: next })
		.eq("id", row.id);
	if (upErr) {
		console.log("  db update fail", upErr.message);
		fail++;
	} else {
		console.log("  ✓", publicUrl.slice(0, 90));
		ok++;
	}
}

console.log(`\nDone: ${ok} rehosted, ${fail} failed`);
console.log("Refresh → https://events-platform-admin.ben-745.workers.dev/ingestion");
