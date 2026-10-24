CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	status TEXT NOT NULL,
	current_stage TEXT NOT NULL,
	artifact_key TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	stage TEXT NOT NULL,
	detail TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id, created_at);
