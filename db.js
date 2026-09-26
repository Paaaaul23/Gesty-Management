'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
// node:sqlite avisa de que es experimental en cada arranque; el aviso no aporta nada al usuario
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...rest));
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'gesty.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  nif TEXT,
  email TEXT,
  phone TEXT,
  plan TEXT NOT NULL DEFAULT 'basico',
  status TEXT NOT NULL DEFAULT 'activo',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','client')),
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  local_id INTEGER REFERENCES locales(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  position TEXT,
  email TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  local_id INTEGER REFERENCES locales(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  source TEXT,
  doc_type TEXT,
  raw_text TEXT,
  ocr_confidence REAL,
  extracted_json TEXT,
  corrected_json TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  validated_at TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ingreso','gasto')),
  fecha TEXT NOT NULL,
  concepto TEXT NOT NULL,
  category TEXT,
  tercero TEXT,
  base REAL NOT NULL DEFAULT 0,
  iva REAL NOT NULL DEFAULT 0,
  retencion REAL NOT NULL DEFAULT 0,
  total REAL,
  paid INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tax_filings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  modelo TEXT NOT NULL,
  year INTEGER NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'presentado',
  presented_at TEXT,
  justificante TEXT,
  amount REAL,
  notes TEXT,
  snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, modelo, year, period)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_log (client_id, entity, entity_id);
CREATE TABLE IF NOT EXISTS doc_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  auto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'cliente' CHECK (kind IN ('cliente','proveedor','ambos')),
  name TEXT NOT NULL,
  nif TEXT,
  address TEXT,
  postal_city TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ref TEXT,
  price REAL NOT NULL DEFAULT 0,
  iva REAL NOT NULL DEFAULT 21,
  unit TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS opening_balances (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  account TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (client_id, year, account)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Migraciones: columnas añadidas después de la primera versión (bases de datos ya creadas)
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('documents', 'direction', "TEXT");           // recibido | emitido
addColumn('documents', 'category', "TEXT");            // categoría contable
addColumn('documents', 'paid', "INTEGER NOT NULL DEFAULT 0");
addColumn('documents', 'paid_at', "TEXT");
addColumn('clients', 'fiscal_json', "TEXT");          // perfil fiscal (forma jurídica, régimen de IVA…)
// Datos de la empresa para los documentos que emite
addColumn('clients', 'address', "TEXT");
addColumn('clients', 'postal_city', "TEXT");
addColumn('clients', 'iban', "TEXT");
addColumn('clients', 'doc_footer', "TEXT");
// Documentos creados en Gesty (presupuestos, pedidos, albaranes, facturas)
addColumn('documents', 'draft_json', "TEXT");          // datos editables del documento
addColumn('documents', 'doc_state', "TEXT");           // borrador | emitido | aceptado | rechazado | servido | entregado | facturado
addColumn('documents', 'series', "TEXT");
addColumn('documents', 'seq', "INTEGER");
addColumn('documents', 'issued_at', "TEXT");
addColumn('documents', 'hash', "TEXT");                // huella encadenada de las facturas emitidas
addColumn('documents', 'prev_hash', "TEXT");
db.exec("UPDATE documents SET direction = COALESCE(json_extract(extracted_json, '$.direction'), 'recibido') WHERE direction IS NULL");

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  if (value === null || value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { db, DATA_DIR, UPLOAD_DIR, hashPassword, verifyPassword, getSetting, setSetting };
