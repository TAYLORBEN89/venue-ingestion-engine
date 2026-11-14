-- Copied from ThinAirSolutionsBuild schema/021_soft_delete_trash.sql.
-- Soft delete / trash: curator "Delete" moves rows out of main lists;
-- restore from /trash. Hard delete only from trash (permanent).

alter table events add column if not exists deleted_at timestamptz;
alter table venues add column if not exists deleted_at timestamptz;
alter table artists add column if not exists deleted_at timestamptz;
alter table deals add column if not exists deleted_at timestamptz;
alter table posts add column if not exists deleted_at timestamptz;
alter table rentals add column if not exists deleted_at timestamptz;
alter table categories add column if not exists deleted_at timestamptz;
alter table regions add column if not exists deleted_at timestamptz;

create index if not exists idx_events_deleted_at on events (deleted_at) where deleted_at is not null;
create index if not exists idx_venues_deleted_at on venues (deleted_at) where deleted_at is not null;
create index if not exists idx_artists_deleted_at on artists (deleted_at) where deleted_at is not null;
create index if not exists idx_deals_deleted_at on deals (deleted_at) where deleted_at is not null;
create index if not exists idx_posts_deleted_at on posts (deleted_at) where deleted_at is not null;
create index if not exists idx_rentals_deleted_at on rentals (deleted_at) where deleted_at is not null;
create index if not exists idx_categories_deleted_at on categories (deleted_at) where deleted_at is not null;
create index if not exists idx_regions_deleted_at on regions (deleted_at) where deleted_at is not null;
