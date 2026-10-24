-- M0 hardening: idempotency key and failure reason for research runs.
ALTER TABLE runs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
	ON runs (project_id, idempotency_key)
	WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status, updated_at);
