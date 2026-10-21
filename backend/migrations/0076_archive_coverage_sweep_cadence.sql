-- Maintenance cadence survives restart; existing rows require a conservative first sweep.
ALTER TABLE archive_coverage ADD COLUMN IF NOT EXISTS sweep_checked_at timestamptz;
