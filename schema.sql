-- migration.sql
-- Run once on D1 database

CREATE TABLE IF NOT EXISTS voice_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_generated_id TEXT UNIQUE NOT NULL,   -- UUID from client
  transcript TEXT NOT NULL,
  normalized TEXT,
  winner TEXT,
  scores TEXT,                  -- JSON string
  entities TEXT,                -- JSON string
  success BOOLEAN,
  version TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_logs_created ON voice_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_voice_logs_cid ON voice_logs(client_generated_id);

CREATE TABLE IF NOT EXISTS voice_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL,                -- references voice_logs.id (not client_generated_id)
  corrected_transcript TEXT NOT NULL,
  corrected_intent TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (log_id) REFERENCES voice_logs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_corrections_log_id ON voice_corrections(log_id);
