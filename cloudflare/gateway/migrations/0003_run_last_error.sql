-- M0 hardening: record why a run failed so failures are never silent.
-- `last_error` was added to 0001 after that migration had already been applied,
-- so it needs its own migration to exist in the live database.
ALTER TABLE runs ADD COLUMN last_error TEXT;
