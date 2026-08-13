-- Events Platform: initial unified schema
-- Target: Postgres (Supabase)
--
-- Design goals:
--   - One schema serves all 4 brands (HeyAustin, HeyCrestedButte, 6thStreet, LakeTravis)
--     via a `sites` table + `site_id` foreign keys, rather than 4 separate databases.
--   - Venues, events, rentals, and posts are the four core content types — confirmed
--     against live recon of the current WordPress sites (HeyAustin, LakeTravis,
--     CrestedButte all run Listify + WP Job Manager + a "rental" post type + a
--     Facebook Events importer + the Listar mobile-app REST API).
--   - AI-ingested events land in a staging table (`ingested_events`) for human
--     review before becoming real `events` rows — mirrors vee.py's matched /
--     missing_on_site / missing_on_venue output, but persisted instead of ad hoc JSON.
--   - Public app users (favorites/wishlist, reviews) are separate from admin_users,
--     confirmed required by the live Listar API's auth/register + wishlist/* routes.
--   - `search_documents` is a hybrid keyword+vector index feeding the AI search
--     feature, kept separate from content tables so re-embedding never touches them.

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ---------------------------------------------------------------------------
-- Multi-tenant root: one row per brand/site
-- ---------------------------------------------------------------------------
create table sites (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,        -- 'heyaustin', 'heycrestedbutte', '6thstreet', 'laketravis'
  name          text not null,
  domain        text unique not null,        -- 'heyaustin.com'
  timezone      text not null default 'America/Chicago',
  brand_config  jsonb not null default '{}', -- theme colors, logo urls, social links, etc.
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Users & roles (admin/curation portal accounts, not public app accounts)
-- ---------------------------------------------------------------------------
create table admin_users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  full_name     text,
  created_at    timestamptz not null default now()
);

create table admin_user_site_roles (
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  site_id       uuid not null references sites(id) on delete cascade,
  role          text not null check (role in ('owner', 'editor', 'curator', 'venue_partner')),
  primary key (admin_user_id, site_id)
);

-- ---------------------------------------------------------------------------
-- Shared taxonomy (categories/tags), scoped per site so brands can diverge
-- ---------------------------------------------------------------------------
create table categories (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  kind          text not null check (kind in ('venue', 'event', 'post', 'rental', 'deal')),
  slug          text not null,
  name          text not null,
  description   text,
  parent_id     uuid references categories(id),
  unique (site_id, kind, slug)
);

-- Regions are a separate hierarchy from categories (confirmed by the live sites'
-- job_listing_region taxonomy existing alongside job_listing_category) — e.g.
-- "North Shore" / "Marina District" as opposed to topical categories like
-- "Distilleries". Kept as its own table rather than overloading `categories`.
create table regions (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  slug          text not null,
  name          text not null,
  parent_id     uuid references regions(id),
  unique (site_id, slug)
);

-- ---------------------------------------------------------------------------
-- Media library
-- ---------------------------------------------------------------------------
create table media (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid references sites(id) on delete set null, -- null = shared across sites
  storage_path  text not null,      -- Supabase Storage path or S3 key
  alt_text      text,
  width         int,
  height        int,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Venue groups: links venue rows across sites that represent the same real
-- -world place (confirmed via recon: 51% of 6thStreet's venues are the same
-- physical venues as HeyAustin's, independently listed/edited on each site).
-- Rows stay separate per site (each keeps its own description/category/
-- editorial voice) — grouping exists only so the admin portal can surface
-- "this venue also exists on X" and so the ingestion pipeline scrapes each
-- real-world venue's calendar once, not once per site it's linked to.
-- A group table (rather than a raw self-referential FK on `venues`) avoids
-- "which row points to which" ambiguity and scales past 2 sites cleanly.
-- ---------------------------------------------------------------------------
create table venue_groups (
  id            uuid primary key default gen_random_uuid(),
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Venues / partner listings (replaces Listify "listing" + WP Job Manager posts)
-- ---------------------------------------------------------------------------
create table venues (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  region_id       uuid references regions(id),
  venue_group_id  uuid references venue_groups(id) on delete set null,
  slug            text not null,
  name            text not null,
  description     text,
  address         text,
  lat             double precision,
  lng             double precision,
  website_url     text,             -- venue's own site, used by ingestion pipeline
  calendar_url    text,             -- discovered/curated events-page URL, used by ingestion pipeline
  phone           text,
  featured_media_id uuid references media(id),
  is_featured     boolean not null default false,
  rating_avg      numeric(3,2) not null default 0,
  rating_count    integer not null default 0,
  status          text not null default 'published' check (status in ('draft', 'published', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (site_id, slug)
);

create table venue_categories (
  venue_id      uuid not null references venues(id) on delete cascade,
  category_id   uuid not null references categories(id) on delete cascade,
  primary key (venue_id, category_id)
);

-- ---------------------------------------------------------------------------
-- Events (the highest-value, most time-consuming content type)
-- ---------------------------------------------------------------------------
create table events (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  venue_id        uuid references venues(id) on delete set null,
  slug            text not null,
  title           text not null,
  description     text,
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  ticket_url      text,
  price_text      text,
  featured_media_id uuid references media(id),
  is_featured     boolean not null default false,
  rating_avg      numeric(3,2) not null default 0,
  rating_count    integer not null default 0,
  status          text not null default 'published' check (status in ('draft', 'published', 'archived')),
  -- 'facebook_import' reflects the Facebook Events importer already running on all
  -- 3 sites checked (1,709 of LakeTravis's events are facebook-sourced) — real
  -- existing automation, distinct from the new AI ingestion pipeline (ai_ingested).
  -- 'user_submitted' covers the public "Submit an Event" flow (see homepage
  -- design) — lands in the same ingested_events-style review queue as
  -- scraped events, just with a human source instead of a scraper.
  source          text not null default 'manual' check (source in ('manual', 'ai_ingested', 'facebook_import', 'user_submitted')),
  ingested_event_id uuid,            -- back-reference if this row originated from ingestion (fk added below)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (site_id, slug)
);

create table event_categories (
  event_id      uuid not null references events(id) on delete cascade,
  category_id   uuid not null references categories(id) on delete cascade,
  primary key (event_id, category_id)
);

-- ---------------------------------------------------------------------------
-- Artists/performers — a 5th content type, surfaced by the HeyAustin homepage
-- design (top-nav "ARTISTS", event cards crediting performers like "Shakey
-- Graves"). Distinct from venues: an artist plays at many venues over time.
-- ---------------------------------------------------------------------------
create table artists (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  slug            text not null,
  name            text not null,
  bio             text,
  featured_media_id uuid references media(id),
  social_links    jsonb not null default '{}', -- instagram, spotify, website, etc.
  status          text not null default 'published' check (status in ('draft', 'published', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (site_id, slug)
);

create table event_artists (
  event_id      uuid not null references events(id) on delete cascade,
  artist_id     uuid not null references artists(id) on delete cascade,
  primary key (event_id, artist_id)
);

-- ---------------------------------------------------------------------------
-- Deals — a 6th content type, also surfaced by the homepage design
-- ("Half Price Cocktails, Loro, 4:00-6:00 PM"). Deliberately separate from
-- `events`: a deal is a recurring offer on a weekly schedule, not a single
-- start/end timestamp, so it doesn't fit the events model.
-- ---------------------------------------------------------------------------
create table deals (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  venue_id        uuid references venues(id) on delete set null,
  slug            text not null,
  title           text not null,
  description     text,
  price_text      text,
  days_of_week    smallint[] not null default '{}', -- 0=Sunday..6=Saturday; empty = every day
  start_time      time,
  end_time        time,
  valid_from      date,
  valid_until     date,
  featured_media_id uuid references media(id),
  is_featured     boolean not null default false,
  status          text not null default 'published' check (status in ('draft', 'published', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (site_id, slug)
);

create table deal_categories (
  deal_id       uuid not null references deals(id) on delete cascade,
  category_id   uuid not null references categories(id) on delete cascade,
  primary key (deal_id, category_id)
);

-- ---------------------------------------------------------------------------
-- Newsletter signup (homepage "Never Miss Out" capture). Just the capture
-- lives here — actual sending is a third-party service (Resend/Mailchimp/
-- etc.), not something to build from scratch.
-- ---------------------------------------------------------------------------
create table newsletter_subscribers (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  email           text not null,
  subscribed_at   timestamptz not null default now(),
  unsubscribed_at timestamptz,
  unique (site_id, email)
);

-- ---------------------------------------------------------------------------
-- Blog posts
-- ---------------------------------------------------------------------------
create table posts (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  author_id       uuid references admin_users(id),
  slug            text not null,
  title           text not null,
  body            text not null,        -- markdown or rich text JSON
  excerpt         text,
  featured_media_id uuid references media(id),
  status          text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at    timestamptz,
  seo_title       text,                 -- AI-generated SEO fields, human-editable
  seo_description text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (site_id, slug)
);

create table post_categories (
  post_id       uuid not null references posts(id) on delete cascade,
  category_id   uuid not null references categories(id) on delete cascade,
  primary key (post_id, category_id)
);

-- ---------------------------------------------------------------------------
-- Rentals (vacation/property rentals) — confirmed as a 4th content type via
-- the live `rental` post type (e.g. laketravis.com/rental/lakefront-home-...)
-- ---------------------------------------------------------------------------
create table rentals (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references sites(id) on delete cascade,
  region_id       uuid references regions(id),
  slug            text not null,
  name            text not null,
  description     text,
  address         text,
  lat             double precision,
  lng             double precision,
  booking_url     text,             -- external booking link (Airbnb/VRBO/direct)
  price_text      text,
  featured_media_id uuid references media(id),
  is_featured     boolean not null default false,
  rating_avg      numeric(3,2) not null default 0,
  rating_count    integer not null default 0,
  status          text not null default 'published' check (status in ('draft', 'published', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (site_id, slug)
);

-- ---------------------------------------------------------------------------
-- Public app users — distinct from admin_users. Required by the live Listar
-- API's auth/register + wishlist/* routes; the mobile apps already have real
-- end users with accounts, not just anonymous browsing.
-- ---------------------------------------------------------------------------
create table app_users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  full_name     text,
  created_at    timestamptz not null default now()
);

-- Polymorphic favorites ("wishlist" in the current Listar API) across all
-- content types rather than 3 separate join tables.
create table favorites (
  id            uuid primary key default gen_random_uuid(),
  app_user_id   uuid not null references app_users(id) on delete cascade,
  target_type   text not null check (target_type in ('venue', 'event', 'rental', 'deal', 'artist')),
  target_id     uuid not null,
  created_at    timestamptz not null default now(),
  unique (app_user_id, target_type, target_id)
);

-- Reviews feed the rating_avg/rating_count aggregates on venues/events/rentals
-- (confirmed live via schema.org AggregateRating markup + rating_avg/rating_count
-- fields already present in the Listar API's event/place responses).
create table reviews (
  id            uuid primary key default gen_random_uuid(),
  app_user_id   uuid not null references app_users(id) on delete cascade,
  target_type   text not null check (target_type in ('venue', 'event', 'rental', 'deal', 'artist')),
  target_id     uuid not null,
  rating        smallint not null check (rating between 1 and 5),
  body          text,
  status        text not null default 'published' check (status in ('published', 'flagged', 'removed')),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- AI-driven search: hybrid keyword (tsvector) + semantic (pgvector) index,
-- kept separate from content tables so re-embedding/re-indexing never requires
-- touching venues/events/posts/rentals directly. Feeds the "understands
-- complete tasks" natural-language search requirement.
-- ---------------------------------------------------------------------------
create table search_documents (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  target_type   text not null check (target_type in ('venue', 'event', 'post', 'rental', 'deal', 'artist')),
  target_id     uuid not null,
  text_content  text not null,           -- flattened title+description+category+region for embedding/search
  tsv           tsvector generated always as (to_tsvector('english', text_content)) stored,
  embedding     vector(1536),            -- text-embedding-3-small dimension; adjust if model changes
  updated_at    timestamptz not null default now(),
  unique (target_type, target_id)
);

create index idx_search_documents_tsv on search_documents using gin (tsv);
create index idx_search_documents_embedding on search_documents using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- AI ingestion pipeline: staging area, mirrors vee.py's diff output
-- ---------------------------------------------------------------------------
create table ingestion_runs (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  venue_id      uuid not null references venues(id) on delete cascade,
  status        text not null check (status in ('running', 'success', 'error')),
  error_message text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create table ingested_events (
  id                uuid primary key default gen_random_uuid(),
  ingestion_run_id  uuid not null references ingestion_runs(id) on delete cascade,
  venue_id          uuid not null references venues(id) on delete cascade,
  raw_title         text not null,
  raw_date_text     text,
  parsed_starts_at  timestamptz,
  parsed_ends_at    timestamptz,
  source_url        text not null,
  match_status      text not null check (match_status in ('new', 'matched_existing', 'needs_review')),
  matched_event_id  uuid references events(id),
  review_status     text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  reviewed_by       uuid references admin_users(id),
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now()
);

alter table events
  add constraint events_ingested_event_id_fkey
  foreign key (ingested_event_id) references ingested_events(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Indexes for the hot paths: upcoming events per site, venue lookups
-- ---------------------------------------------------------------------------
create index idx_events_site_starts_at on events (site_id, starts_at) where status = 'published';
create index idx_events_site_featured on events (site_id, starts_at) where status = 'published' and is_featured;
create index idx_venues_site_status on venues (site_id, status);
create index idx_venues_geo on venues (lat, lng);
create index idx_venues_group on venues (venue_group_id) where venue_group_id is not null;
create index idx_rentals_site_status on rentals (site_id, status);
create index idx_posts_site_published on posts (site_id, published_at) where status = 'published';
create index idx_ingested_events_review_status on ingested_events (review_status);
create index idx_favorites_app_user on favorites (app_user_id);
create index idx_reviews_target on reviews (target_type, target_id);
create index idx_deals_site_status on deals (site_id, status);
create index idx_artists_site_status on artists (site_id, status);
