-- Migration number: 0003
-- Add event_id (≤64 char, optional, UUID v4 recommended) with idempotent dedup:
-- repeated POST /collect of the same (app_id, event_id) returns 204 but does NOT
-- write a second row. Lifetime UNIQUE (no time window) — UUID v4 collisions are
-- effectively impossible, and lifetime semantics are simpler than a 7-day window.
-- Events without event_id are not covered by the constraint.

ALTER TABLE events ADD COLUMN event_id TEXT;

CREATE UNIQUE INDEX idx_events_appid_event_id
  ON events(app_id, event_id)
  WHERE event_id IS NOT NULL;
