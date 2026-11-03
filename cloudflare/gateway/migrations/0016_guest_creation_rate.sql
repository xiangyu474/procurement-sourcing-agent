-- Fixed-window creation counters. Scope is either a global constant or an
-- HMAC of the client IP; raw addresses are never stored. Counts are charged
-- before session creation and are deliberately not refunded on later failure.
CREATE TABLE IF NOT EXISTS guest_session_creation_windows (
    scope TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count >= 0),
    PRIMARY KEY (scope, window_start)
);

CREATE INDEX IF NOT EXISTS idx_guest_session_creation_expiry
    ON guest_session_creation_windows(window_start);
