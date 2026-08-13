function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	const cut = text.slice(0, maxLen - 1);
	const lastSpace = cut.lastIndexOf(" ");
	return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxLen - 1)}…`;
}

export interface SeoFields {
	focus_keyphrase: string;
	seo_title: string;
	seo_description: string;
}

/** Evergreen artist SEO — no venue, date, or year. Reused on every event for that artist. */
export function generateEvergreenArtistSeo(params: {
	name: string;
	bio?: string | null;
	genres?: string[];
	city?: string | null;
}): SeoFields {
	const { name, bio, genres = [], city } = params;
	const isComedy = genres.some((g) => /\bcomedy\b|\bstand[- ]?up\b|\bimprov\b/i.test(g));
	const primaryGenre = genres[0] ?? (isComedy ? "Comedy" : "Live Music");
	const genreTail = genres.length > 1 ? genres.slice(0, 2).join(" & ") : primaryGenre;

	const focus_keyphrase = `${name} ${primaryGenre}`.trim();

	let seo_title: string;
	if (city) {
		seo_title = truncate(`${name} | ${city} ${primaryGenre}`, 60);
	} else {
		seo_title = truncate(`${name} | ${genreTail}`, 60);
	}

	let seo_description: string;
	if (bio && bio.trim().length > 40) {
		seo_description = truncate(bio.trim(), 156);
	} else if (isComedy || /\bcomedy\b/i.test(primaryGenre)) {
		seo_description = truncate(
			`${name} is a stand-up comedian${city ? ` in ${city}` : ""}. Find upcoming comedy shows, tickets, and event details.`,
			156,
		);
	} else if (genres.length > 0) {
		seo_description = truncate(
			`${name} delivers ${genreTail.toLowerCase()} with an energetic live show perfect for music venues, dance halls, and festivals.`,
			156,
		);
	} else {
		seo_description = truncate(
			`${name} — live music in ${city ?? "Austin"}. Find upcoming shows, tickets, artist video, and event details.`,
			156,
		);
	}

	return { focus_keyphrase, seo_title, seo_description };
}

export function resolveEvergreenArtistSeo(
	artist: {
		name: string;
		bio?: string | null;
		genres?: string[];
		seo_title?: string | null;
		seo_description?: string | null;
		focus_keyphrase?: string | null;
	},
	city?: string | null,
): SeoFields {
	if (artist.seo_title && artist.seo_description) {
		return {
			seo_title: artist.seo_title,
			seo_description: artist.seo_description,
			focus_keyphrase:
				artist.focus_keyphrase ??
				generateEvergreenArtistSeo({ name: artist.name, bio: artist.bio, genres: artist.genres, city }).focus_keyphrase,
		};
	}
	return generateEvergreenArtistSeo({
		name: artist.name,
		bio: artist.bio,
		genres: artist.genres,
		city,
	});
}