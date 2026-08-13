# Venues

One folder per HeyAustin pilot venue. **Start here.**

| File | What it is |
|------|------------|
| [`catalog.json`](./catalog.json) | All slugs, calendar URLs, platforms |
| `<slug>/source.json` | Seed fields for that venue |
| `<slug>/README.md` | How to scrape / ingest it |

Runnable pilots stay in [`engine/scripts/`](../engine/scripts/) so they can read `engine/.dev.vars`. Each venue README points at the script.

## Dedicated pilots (32)

| Folder | Platform |
|--------|----------|
| [acl-live](./acl-live/) | axs |
| [cactus-cafe](./cactus-cafe/) | drupal_events |
| [cap-city-comedy-club](./cap-city-comedy-club/) | seatengine |
| [celis-brewery](./celis-brewery/) | wix_events |
| [circuit-of-the-americas](./circuit-of-the-americas/) | custom_html |
| [come-and-take-it-live](./come-and-take-it-live/) | rhp_events |
| [coupland-dancehall](./coupland-dancehall/) | etix |
| [doc-s-bar-and-grill](./doc-s-bar-and-grill/) | spotapps |
| [donns-depot](./donns-depot/) | schema_events |
| [elephant-room](./elephant-room/) | zoogle |
| [esther-s-follies](./esther-s-follies/) | esthers_follies |
| [flamingo-cantina](./flamingo-cantina/) | tec |
| [friends-bar](./friends-bar/) | wix_events |
| [frontyard-brewing](./frontyard-brewing/) | squarespace_events |
| [germania-insurance-amphitheater](./germania-insurance-amphitheater/) | custom_html |
| [gueros-taco-bar](./gueros-taco-bar/) | tec |
| [hole-in-the-wall](./hole-in-the-wall/) | prekindle |
| [jester-king](./jester-king/) | spacecrafted |
| [moontower-saloon](./moontower-saloon/) | spotapps |
| [poodie-s-hilltop-roadhouse](./poodie-s-hilltop-roadhouse/) | outhousetickets + scrape packet |
| [san-jac-saloon](./san-jac-saloon/) | ical |
| [speakeasy](./speakeasy/) | eventon |
| [the-carousel-lounge](./the-carousel-lounge/) | tec |
| [the-hideout-theatre](./the-hideout-theatre/) | events_manager |
| [the-historic-scoot-inn](./the-historic-scoot-inn/) | livenation |
| [the-long-center](./the-long-center/) | eventon |
| [the-mohawk](./the-mohawk/) | prekindle |
| [the-saxon-pub](./the-saxon-pub/) | tec |
| [the-velveeta-room](./the-velveeta-room/) | seatengine |
| [the-white-horse](./the-white-horse/) | wix_events |
| [vista-brewing](./vista-brewing/) | squarespace_events |
| [vulcan-gas-company](./vulcan-gas-company/) | webflow |

## Completed via generic pipeline (7)

No dedicated ingest script — probe notes only:

[antones-nightclub](./antones-nightclub/), [buck-s-backyard](./buck-s-backyard/), [hotel-vegas](./hotel-vegas/), [meanwhile-brewing-company](./meanwhile-brewing-company/), [moody-amphitheater-austin](./moody-amphitheater-austin/), [stubb-s-bbq](./stubb-s-bbq/), [the-moody-center](./the-moody-center/).

## Reseed + run

1. Create `sites` + `venues` (this slug) + `venue_event_sources` from `source.json`.
2. `cd engine` and run the script in that venue’s README.

The live Supabase dump is not in this package. These folders *are* the venue delivery.
