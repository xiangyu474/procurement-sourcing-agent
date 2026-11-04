-- A visitor may retry a report that failed. The retry is a separate billable
-- operation, so it gets its own admission kind and its own budget units.
-- The table is rebuilt because SQLite cannot alter a CHECK constraint.
CREATE TABLE guest_task_admissions_rebuilt (
    operation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('COMPILE', 'PIPELINE', 'REPORT')),
    request_hash TEXT NOT NULL,
    day_window INTEGER NOT NULL,
    reserved_units INTEGER NOT NULL CHECK (reserved_units > 0),
    state TEXT NOT NULL CHECK (state IN ('HELD', 'RELEASED')),
    created_at TEXT NOT NULL,
    released_at TEXT
);

INSERT INTO guest_task_admissions_rebuilt
    (operation_id, session_id, project_id, operation_kind, request_hash, day_window, reserved_units, state, created_at, released_at)
SELECT operation_id, session_id, project_id, operation_kind, request_hash, day_window, reserved_units, state, created_at, released_at
FROM guest_task_admissions;

DROP TABLE guest_task_admissions;

ALTER TABLE guest_task_admissions_rebuilt RENAME TO guest_task_admissions;

CREATE INDEX IF NOT EXISTS idx_guest_admissions_active
    ON guest_task_admissions(state, session_id);
CREATE INDEX IF NOT EXISTS idx_guest_admissions_day
    ON guest_task_admissions(day_window, session_id);
