export interface VenueIngestionParams {
	venueId: string;
	sourceId?: string;
}

/** LLM scrape fallback shape — kept separate from PartnerEvent. */
export interface ExtractedEvent {
	raw_title: string;
	raw_date_text: string;
	parsed_starts_at: string | null;
	parsed_ends_at: string | null;
	description: string | null;
	price_text: string | null;
	ticket_url: string | null;
	image_url: string | null;
	confidence: number;
}