import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'print-server.db'));

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    printer_id TEXT NOT NULL,
    usb_path TEXT NOT NULL,
    escpos_bytes BLOB NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','printing','done','failed','dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    error TEXT,
    round_id TEXT,
    restaurant_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    next_retry_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_usb_path ON print_jobs(usb_path, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_printer_id ON print_jobs(printer_id);
`);

export default db;
