/** Extract YouTube video ID from embed HTML, embed URL, watch URL, or youtu.be. */
export function extractYouTubeId(input: string | null | undefined): string | null {
	if (!input) return null;
	const trimmed = input.trim();
	if (!trimmed) return null;

	const iframeSrc = trimmed.match(/src=["']https?:\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i);
	if (iframeSrc) return iframeSrc[1];

	const patterns = [
		/(?:youtube\.com\/embed\/|youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/i,
		/^([a-zA-Z0-9_-]{11})$/,
	];

	for (const pattern of patterns) {
		const match = trimmed.match(pattern);
		if (match) return match[1];
	}

	return null;
}

function extractYouTubeEmbedSrc(input: string): string | null {
	const iframeSrc = input.match(/src=["']([^"']+)["']/i)?.[1];
	if (iframeSrc) return iframeSrc.startsWith("//") ? `https:${iframeSrc}` : iframeSrc;

	if (/^https?:\/\//i.test(input) || input.startsWith("//")) {
		return input.startsWith("//") ? `https:${input}` : input;
	}

	return null;
}

function buildYouTubeEmbedFromSrc(src: string): string {
	return `<iframe width="560" height="315" src="${src}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}

/** Normalize iframe HTML or embed URL to stored { embed, id } fields. */
export function extractYouTubeFields(input: string | null | undefined): {
	youtube_embed: string | null;
	youtube_id: string | null;
} {
	if (!input?.trim()) return { youtube_embed: null, youtube_id: null };

	const trimmed = input.trim();
	const videoId = extractYouTubeId(trimmed);
	if (videoId) {
		const embed = trimmed.includes("<iframe")
			? trimmed
			: buildYouTubeEmbedFromSrc(`https://www.youtube.com/embed/${videoId}`);
		return { youtube_embed: embed, youtube_id: videoId };
	}

	const src = extractYouTubeEmbedSrc(trimmed);
	if (src && /youtube\.com\/embed/i.test(src)) {
		return {
			youtube_embed: trimmed.includes("<iframe") ? trimmed : buildYouTubeEmbedFromSrc(src),
			youtube_id: null,
		};
	}

	return { youtube_embed: trimmed.includes("<iframe") ? trimmed : null, youtube_id: null };
}