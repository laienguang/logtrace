-- Migration number: 0002
-- Extend events with business_user_id (caller's business user id), platform (端),
-- and app_version (客户端版本号 / git short sha). These are caller-provided fields
-- and are distinct from events.user_id which is the dashboard app owner.

ALTER TABLE events ADD COLUMN business_user_id TEXT;
ALTER TABLE events ADD COLUMN platform         TEXT;
ALTER TABLE events ADD COLUMN app_version      TEXT;

CREATE INDEX idx_events_buid_server_ts
  ON events(business_user_id, server_ts)
  WHERE business_user_id IS NOT NULL;
