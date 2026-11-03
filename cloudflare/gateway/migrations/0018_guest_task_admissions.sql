-- Admission bookkeeping only. It is not wired to public tasks and does not
-- enforce actual provider calls or monetary spend; Guest work remains disabled.
CREATE TABLE IF NOT EXISTS guest_task_admissions (
    operation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('COMPILE', 'PIPELINE')),
    request_hash TEXT NOT NULL,
    day_window INTEGER NOT NULL,
    reserved_units INTEGER NOT NULL CHECK (reserved_units > 0),
    state TEXT NOT NULL CHECK (state IN ('HELD', 'RELEASED')),
    created_at TEXT NOT NULL,
    released_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_guest_admissions_active
    ON guest_task_admissions(state, session_id);
CREATE INDEX IF NOT EXISTS idx_guest_admissions_day
    ON guest_task_admissions(day_window, session_id);
