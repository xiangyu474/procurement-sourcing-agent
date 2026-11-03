-- Authenticated guest request fixed windows. Counts do not grant any expensive
-- model operation and do not replace deployment-level model cost budgets.
CREATE TABLE IF NOT EXISTS guest_request_windows (
    scope TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count >= 0),
    PRIMARY KEY (scope, window_start)
);

CREATE INDEX IF NOT EXISTS idx_guest_request_window_expiry
    ON guest_request_windows(window_start);
