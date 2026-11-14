-- Copied from ThinAirSolutionsBuild schema/007_artist_youtube_genres.sql.
-- Artist master record: full YouTube embed for web, video ID for mobile app.
-- Genres travel with the artist and copy to events on publish.

alter table artists
  add column youtube_embed text,
  add column youtube_id text,
  add column genres text[] not null default '{}';

alter table events
  add column youtube_embed text,
  add column youtube_id text,
  add column genres text[] not null default '{}';

create index idx_artists_youtube_id on artists (youtube_id) where youtube_id is not null;
