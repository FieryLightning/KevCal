// Storage. KevCal owns its own store; calendars are a projection of it.
// That is forced by three research requirements a calendar cannot satisfy:
// batch undo needs import provenance, the amendment diff needs the previous
// version, and "show me where this came from" needs the source crop.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.KEVCAL_DATA || path.join(ROOT, 'data');
export const ORIGINALS_DIR = path.join(DATA_DIR, 'originals');

fs.mkdirSync(ORIGINALS_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'kevcal.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS batches (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  source_kind     TEXT NOT NULL,          -- image | pdf | text | manual
  source_name     TEXT,
  source_path     TEXT,                   -- relative to data/originals
  source_text     TEXT,
  source_w        INTEGER,
  source_h        INTEGER,
  engine          TEXT NOT NULL,          -- vision+grammar | anthropic | manual
  status          TEXT NOT NULL,          -- draft | committed | undone
  risk            TEXT NOT NULL,          -- low | high
  parent_id       TEXT REFERENCES batches(id),
  anchor_json     TEXT,
  created_at      TEXT NOT NULL,
  committed_at    TEXT,
  undone_at       TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id                    TEXT PRIMARY KEY,
  batch_id              TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,    -- event | deadline
  title                 TEXT NOT NULL,
  start_date            TEXT,
  start_time            TEXT,
  end_date              TEXT,
  end_time              TEXT,
  all_day               INTEGER NOT NULL DEFAULT 1,
  location              TEXT,
  owner                 TEXT,
  cost                  TEXT,
  notes                 TEXT,
  confidence            REAL NOT NULL DEFAULT 0.5,
  needs_review          INTEGER NOT NULL DEFAULT 0,
  reviewed              INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|superseded
  satisfied             INTEGER NOT NULL DEFAULT 0,
  satisfied_at          TEXT,
  lead_days             TEXT,             -- JSON array of days-before
  recurrence_suggestion TEXT,             -- JSON; never auto-applied
  recurrence_accepted   INTEGER NOT NULL DEFAULT 0,
  rrule                 TEXT,
  question              TEXT,
  heading               TEXT,
  src_page              INTEGER,
  src_bbox              TEXT,
  src_raw               TEXT,
  src_interpretation    TEXT,
  fingerprint           TEXT NOT NULL,
  user_edited           INTEGER NOT NULL DEFAULT 0,
  derived_from          TEXT,             -- seam for deadline chains (v1.1)
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_batch ON items(batch_id);
CREATE INDEX IF NOT EXISTS idx_items_date  ON items(start_date);
CREATE INDEX IF NOT EXISTS idx_items_fp    ON items(fingerprint);

CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT REFERENCES batches(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  label       TEXT,
  item_ids    TEXT,                       -- JSON array; NULL = all accepted
  created_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  fetch_count INTEGER NOT NULL DEFAULT 0,
  last_fetch  TEXT
);

CREATE TABLE IF NOT EXISTS anchors (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  week1_start  TEXT,
  skip_weeks   TEXT,
  holidays     TEXT,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  month       TEXT NOT NULL,          -- YYYY-MM, local time
  reader      TEXT NOT NULL,
  model       TEXT,
  in_tokens   INTEGER,
  out_tokens  INTEGER,
  estimated   INTEGER NOT NULL DEFAULT 0,  -- 1 when the provider reported no counts
  cost        REAL NOT NULL DEFAULT 0,     -- estimated USD, never an invoice
  batch_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_month ON usage(month);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  action   TEXT NOT NULL,
  batch_id TEXT,
  item_id  TEXT,
  detail   TEXT
);
`);

/** Additive migrations: safe to run on every start. */
function addColumn(table, definition, name) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
addColumn('items', 'undo_marked INTEGER NOT NULL DEFAULT 0', 'undo_marked');
// v2: the checker's findings travel with the item, so the UI can show exactly
// what was assumed and offer the alternative reading as a button.
addColumn('items', 'flags TEXT', 'flags');
addColumn('items', 'blocked INTEGER NOT NULL DEFAULT 0', 'blocked');
addColumn('items', 'date_basis TEXT', 'date_basis');
addColumn('batches', 'doc_date TEXT', 'doc_date');
addColumn('batches', 'tz TEXT', 'tz');
addColumn('batches', 'captured_at_local TEXT', 'captured_at_local');

export function nowISO() { return new Date().toISOString(); }

export function id(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function log(action, { batch_id = null, item_id = null, detail = null } = {}) {
  db.prepare('INSERT INTO audit (at, action, batch_id, item_id, detail) VALUES (?,?,?,?,?)')
    .run(nowISO(), action, batch_id, item_id, typeof detail === 'string' ? detail : JSON.stringify(detail ?? null));
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

/** Defaults chosen from research: deadlines need a runway, not a 15-minute ping. */
export const DEFAULT_LEAD_DAYS = {
  deadline: [30, 14, 7, 2, 0],
  event: [1, 0],
  // Named ladders the user can pick per item.
  ladders: {
    'Long lead (courses, renewals)': [90, 60, 30, 14, 7, 3, 1, 0],
    'Standard deadline': [30, 14, 7, 2, 0],
    'Short notice': [7, 2, 0],
    'Event reminder': [1, 0],
    'None': [],
  },
};

if (getSetting('initialised') !== true) {
  setSetting('initialised', true);
  setSetting('ai_enabled', false);
  setSetting('lead_days', { deadline: DEFAULT_LEAD_DAYS.deadline, event: DEFAULT_LEAD_DAYS.event });
  log('init', { detail: 'database created' });
}
