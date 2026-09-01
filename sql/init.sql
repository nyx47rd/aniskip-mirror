-- AniSkip Mirror - database schema (matches the AniSkip API source exactly).
-- Adapted from https://github.com/aniskip/aniskip-api (MIT, Lexes Jan Mantiquilla).
-- Requires the pgcrypto extension for gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS skip_times (
  skip_id          uuid          UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  anime_id         integer       NOT NULL,
  episode_number   real          NOT NULL,
  provider_name    varchar(64)   NOT NULL,
  skip_type        char(2)       NOT NULL,
  votes            integer       NOT NULL DEFAULT 0,
  start_time       real          NOT NULL,
  end_time         real          NOT NULL,
  episode_length   real          NOT NULL,
  submit_date      timestamp     NOT NULL DEFAULT NOW()::timestamp,
  submitter_id     uuid          NOT NULL,
  PRIMARY KEY (skip_id),
  CONSTRAINT check_type            CHECK (skip_type IN ('op', 'ed')),
  CONSTRAINT check_anime_length    CHECK (episode_length >= 0),
  CONSTRAINT check_start_time      CHECK (start_time >= 0),
  CONSTRAINT check_anime_id        CHECK (anime_id >= 0),
  CONSTRAINT check_episode_number  CHECK (episode_number >= 0.5),
  CONSTRAINT check_end_time        CHECK (
    end_time >= 0
    AND end_time >  start_time
    AND end_time <= episode_length
  )
);

-- Hot-path lookup: filter by anime + episode + skip_type, ordered by votes.
-- This matches the official query in
-- src/repositories/skip-times.repository.ts (findSkipTimes).
CREATE INDEX IF NOT EXISTS idx_skip_times_lookup
  ON skip_times (anime_id, episode_number, skip_type, votes DESC);

-- Covering index for the subset of columns actually selected by the API.
CREATE INDEX IF NOT EXISTS idx_skip_times_covering
  ON skip_times (anime_id, episode_number, skip_type, votes DESC)
  INCLUDE (skip_id, start_time, end_time, episode_length);

CREATE INDEX IF NOT EXISTS idx_skip_times_anime_id
  ON skip_times (anime_id);