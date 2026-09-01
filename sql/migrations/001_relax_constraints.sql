-- Mirrors aniskip-api/sql_scripts/migration_1.sql verbatim, plus the CSV
-- import tweaks we actually need (drop episode_number >= 0.5, accept
-- skip_type set used by the public dataset, set skip_type to VARCHAR(32)).
--
-- Run AFTER init.sql.

ALTER TABLE skip_times
  DROP CONSTRAINT IF EXISTS check_type;

ALTER TABLE skip_times
  ADD CONSTRAINT check_type CHECK (
    skip_type IN ('op', 'ed', 'mixed-op', 'mixed-ed', 'recap')
  );

ALTER TABLE skip_times
  ALTER COLUMN skip_type TYPE VARCHAR(32);

ALTER TABLE skip_times
  ALTER COLUMN skip_type SET NOT NULL;

ALTER TABLE skip_times
  DROP CONSTRAINT IF EXISTS check_episode_number;

ALTER TABLE skip_times
  ADD CONSTRAINT check_episode_number CHECK (episode_number >= 0.0);

-- The public CSV contains a small number of rows where end_time >
  -- episode_length (e.g. anime 51105 / ep 8 / Himitsu: episode_length =
  -- ~1.48e6 but start_time=104021, end_time=193985 -- those are still
  -- within bounds for a single value but a few legacy entries exceed it).
  -- Drop the strict bound so the public dataset can be imported
  -- unmodified.
ALTER TABLE skip_times
  DROP CONSTRAINT IF EXISTS check_end_time;

ALTER TABLE skip_times
  ADD CONSTRAINT check_end_time CHECK (
    end_time >= 0
    AND end_time > start_time
  );