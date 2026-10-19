-- Anonymous events. Never prompts, outputs, IPs or user agents (TRD FR30).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT,
  page TEXT NOT NULL,          -- qwen | llama | whisper
  type TEXT NOT NULL,          -- page_view | check_done | load_start | load_done | run_done | error | cloud_call
  device_class TEXT,           -- mobile | desktop
  webgpu INTEGER,              -- 0/1
  gpu_vendor TEXT,
  verdict TEXT,                -- LOCAL | LOCAL_SMALLER | CLOUD_ONLY
  mode TEXT,                   -- local | cloud
  load_ms REAL,
  tokens_per_sec REAL,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS events_page_type ON events (page, type);

-- Cloud calls per UTC day, for the hard daily cap.
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
