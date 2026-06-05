-- Migration number: 0001
-- logtrace initial schema: users (google login), apps (multi-tenant ingest keys),
-- and events (raw events). events.user_id is the Google login user id coming from
-- the caller; apps.user_id tracks which dashboard user created the app.

CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE INDEX idx_users_email ON users(email);

CREATE TABLE apps (
  app_id      TEXT UNIQUE NOT NULL,
  app_key     TEXT PRIMARY KEY,
  app_secret  TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL,
  user_id     TEXT NOT NULL
);
CREATE INDEX idx_apps_app_id ON apps(app_id);
CREATE INDEX idx_apps_user_id ON apps(user_id);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  event_name  TEXT    NOT NULL,
  distinct_id TEXT,
  user_id     TEXT,
  session_id  TEXT,
  client_ts   INTEGER,
  server_ts   INTEGER NOT NULL,
  url         TEXT,
  referrer    TEXT,
  ua          TEXT,
  ip_country  TEXT,
  app_id      TEXT    NOT NULL,
  props       TEXT
);

CREATE INDEX idx_events_server_ts        ON events(server_ts);
CREATE INDEX idx_events_name_server_ts   ON events(event_name, server_ts);
CREATE INDEX idx_events_did_server_ts    ON events(distinct_id, server_ts);
CREATE INDEX idx_events_uid_server_ts    ON events(user_id, server_ts) WHERE user_id IS NOT NULL;
CREATE INDEX idx_events_appid_server_ts  ON events(app_id, server_ts);
