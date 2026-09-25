'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, UPLOAD_DIR, hashPassword, verifyPassword, getSetting, setSetting } = require('./db');
const { analyze } = require('./extract');
const ai = require('./ai');
const acc = require('./accounting');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 7;
const COOKIE = 'gesty_session';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------- sesiones

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

app.use((req, res, next) => {
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.client_id, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (row && row.expires_at > Date.now()) req.user = row;
    else if (row) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  next();
});

const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Sesión no iniciada' });
const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Solo administradores' });

// Cliente sobre el que actúa la petición: el propio para usuarios cliente,
// el indicado en ?cid= para el administrador.
function clientScope(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sesión no iniciada' });
  const cid = req.user.role === 'admin' ? Number(req.query.cid) : req.user.client_id;
  if (!cid) return res.status(400).json({ error: 'Falta el cliente' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(cid);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (client.status === 'suspendido' && req.user.role !== 'admin') return res.status(403).json({ error: 'Cuenta suspendida. Contacta con el administrador.' });
  req.client = client;
  next();
}

const clean = v => (v === undefined || v === null ? null : String(v).trim() || null);

// ---------------------------------------------------------------- auth

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  if (user.role === 'client') {
    const c = db.prepare('SELECT status FROM clients WHERE id = ?').get(user.client_id);
    if (c?.status === 'suspendido') return res.status(403).json({ error: 'Cuenta suspendida. Contacta con el administrador.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  res.json({ role: user.role, redirect: user.role === 'admin' ? '/admin' : '/app' });
});

app.post('/api/logout', (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const { id, email, name, role, client_id } = req.user;
  const client = client_id ? db.prepare('SELECT id, name, nif, status FROM clients WHERE id = ?').get(client_id) : null;
  res.json({ id, email, name, role, client });
});

app.post('/api/me/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current || ''), user.password_hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  if (String(next || '').length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- administración

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const one = sql => db.prepare(sql).get().n;
  res.json({
    clients: one('SELECT COUNT(*) n FROM clients'),
    active: one("SELECT COUNT(*) n FROM clients WHERE status = 'activo'"),
    locales: one('SELECT COUNT(*) n FROM locales'),
    employees: one('SELECT COUNT(*) n FROM employees WHERE active = 1'),
    documents: one('SELECT COUNT(*) n FROM documents'),
    validated: one("SELECT COUNT(*) n FROM documents WHERE status = 'validado'"),
  });
});

app.get('/api/admin/clients', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM locales l WHERE l.client_id = c.id) AS locales,
      (SELECT COUNT(*) FROM employees e WHERE e.client_id = c.id AND e.active = 1) AS employees,
      (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id) AS documents,
      (SELECT email FROM users u WHERE u.client_id = c.id ORDER BY u.id LIMIT 1) AS owner_email
    FROM clients c ORDER BY c.created_at DESC, c.id DESC`).all());
});

app.post('/api/admin/clients', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = clean(b.name), ownerEmail = clean(b.owner_email), ownerPassword = String(b.owner_password || '');
  if (!name) return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });
  if (!ownerEmail || !/^\S+@\S+\.\S+$/.test(ownerEmail)) return res.status(400).json({ error: 'Email de acceso no válido' });
  if (ownerPassword.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(ownerEmail)) return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
  db.exec('BEGIN');
  try {
    const c = db.prepare('INSERT INTO clients (name, nif, email, phone, plan) VALUES (?, ?, ?, ?, ?)')
      .run(name, clean(b.nif), clean(b.email) || ownerEmail, clean(b.phone), clean(b.plan) || 'basico');
    db.prepare("INSERT INTO users (email, password_hash, name, role, client_id) VALUES (?, ?, ?, 'client', ?)")
      .run(ownerEmail, hashPassword(ownerPassword), clean(b.owner_name) || name, c.lastInsertRowid);
    db.exec('COMMIT');
    res.status(201).json({ id: Number(c.lastInsertRowid) });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

app.get('/api/admin/clients/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({
    client,
    users: db.prepare('SELECT id, email, name, created_at FROM users WHERE client_id = ?').all(id),
    locales: db.prepare('SELECT * FROM locales WHERE client_id = ? ORDER BY name').all(id),
    employees: db.prepare(`SELECT e.*, l.name AS local_name FROM employees e LEFT JOIN locales l ON l.id = e.local_id WHERE e.client_id = ? ORDER BY e.name`).all(id),
    documents: db.prepare(`SELECT COUNT(*) total, SUM(status = 'validado') validated FROM documents WHERE client_id = ?`).get(id),
  });
});

app.patch('/api/admin/clients/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (b.status && !['activo', 'suspendido'].includes(b.status)) return res.status(400).json({ error: 'Estado no válido' });
  const merged = { ...client, ...Object.fromEntries(['name', 'nif', 'email', 'phone', 'plan', 'status'].filter(k => k in b).map(k => [k, clean(b[k])])) };
  if (!merged.name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  db.prepare('UPDATE clients SET name=?, nif=?, email=?, phone=?, plan=?, status=? WHERE id=?')
    .run(merged.name, merged.nif, merged.email, merged.phone, merged.plan || 'basico', merged.status || 'activo', id);
  if (merged.status === 'suspendido') db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE client_id = ?)').run(id);
  res.json({ ok: true });
});

app.post('/api/admin/clients/:id/password', requireAdmin, (req, res) => {
  const pwd = String(req.body?.password || '');
  if (pwd.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  const r = db.prepare('UPDATE users SET password_hash = ? WHERE id = (SELECT id FROM users WHERE client_id = ? ORDER BY id LIMIT 1)').run(hashPassword(pwd), Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'El cliente no tiene usuario de acceso' });
  res.json({ ok: true });
});

app.delete('/api/admin/clients/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const files = db.prepare('SELECT stored_name FROM documents WHERE client_id = ?').all(id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

// Lectura con IA: clave de la API de Anthropic y modelo
function aiStatus() {
  const cfg = ai.config();
  const key = cfg.apiKey;
  return {
    enabled: cfg.enabled,
    switchOn: getSetting('ai_enabled', '1') === '1',
    configured: !!key,
    source: cfg.source,
    keyHint: key ? key.slice(0, 7) + '…' + key.slice(-4) : null,
    model: cfg.model,
    models: ai.MODELS,
  };
}
app.get('/api/admin/ai', requireAdmin, (req, res) => res.json(aiStatus()));
app.put('/api/admin/ai', requireAdmin, (req, res) => {
  const b = req.body || {};
  if ('apiKey' in b) {
    const k = clean(b.apiKey);
    if (k && !/^sk-ant-[A-Za-z0-9_\-]{10,}$/.test(k)) return res.status(400).json({ error: 'La clave no tiene el formato de una clave de Anthropic (sk-ant-…)' });
    setSetting('ai_api_key', k);
  }
  if ('model' in b) {
    if (!ai.MODELS.some(m => m.id === b.model)) return res.status(400).json({ error: 'Modelo no válido' });
    setSetting('ai_model', b.model);
  }
  if ('enabled' in b) setSetting('ai_enabled', b.enabled ? '1' : '0');
  res.json(aiStatus());
});
app.post('/api/admin/ai/test', requireAdmin, async (req, res) => {
  try { res.json(await ai.testConnection({ apiKey: clean(req.body?.apiKey), model: req.body?.model })); }
  catch (e) { res.status(400).json({ error: 'No se ha podido conectar: ' + (e.status === 401 ? 'la clave no es válida' : e.status === 404 ? 'modelo no disponible para esta clave' : e.message) }); }
});

// ---------------------------------------------------------------- panel del cliente

const c = express.Router();
c.use(clientScope);

c.get('/summary', (req, res) => {
  const id = req.client.id;
  const one = (sql, ...a) => db.prepare(sql).get(id, ...a);
  res.json({
    client: req.client,
    locales: one('SELECT COUNT(*) n FROM locales WHERE client_id = ?').n,
    employees: one('SELECT COUNT(*) n FROM employees WHERE client_id = ? AND active = 1').n,
    documents: one('SELECT COUNT(*) n FROM documents WHERE client_id = ?').n,
    pending: one("SELECT COUNT(*) n FROM documents WHERE client_id = ? AND status = 'pendiente'").n,
    byType: db.prepare("SELECT COALESCE(json_extract(corrected_json, '$.doc_type'), doc_type, 'otro') t, COUNT(*) n FROM documents WHERE client_id = ? GROUP BY t").all(id),
    byDirection: db.prepare("SELECT direction d, COUNT(*) n FROM documents WHERE client_id = ? GROUP BY direction").all(id),
    finance: (() => {
      // Año en curso; si aún no tiene movimientos, el último año que sí los tenga
      const all = accountingEntries(id, false);
      const years = all.map(e => Number(e.date.slice(0, 4))).filter(Boolean);
      const now = new Date().getFullYear();
      const year = years.includes(now) || !years.length ? now : Math.max(...years);
      const r = acc.compute(all, { year });
      return { year, ...r.totals, porCobrar: r.pending.porCobrar.total, porPagar: r.pending.porPagar.total };
    })(),
    recent: db.prepare('SELECT id, filename, doc_type, direction, status, created_at, extracted_json FROM documents WHERE client_id = ? ORDER BY id DESC LIMIT 6').all(id)
      .map(d => ({ ...d, extracted_json: undefined, score: JSON.parse(d.extracted_json || '{}').score ?? null })),
    accuracy: accuracyFor(id).overall,
  });
});

c.get('/company', (req, res) => res.json(req.client));
c.patch('/company', (req, res) => {
  const b = req.body || {};
  const name = clean(b.name) || req.client.name;
  db.prepare('UPDATE clients SET name=?, nif=?, email=?, phone=? WHERE id=?')
    .run(name, clean(b.nif), clean(b.email), clean(b.phone), req.client.id);
  res.json({ ok: true });
});

// Locales
c.get('/locales', (req, res) => {
  res.json(db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM employees e WHERE e.local_id = l.id AND e.active = 1) AS employees
    FROM locales l WHERE l.client_id = ? ORDER BY l.name`).all(req.client.id));
});
c.post('/locales', (req, res) => {
  const name = clean(req.body?.name);
  if (!name) return res.status(400).json({ error: 'El nombre del local es obligatorio' });
  const r = db.prepare('INSERT INTO locales (client_id, name, address, city) VALUES (?, ?, ?, ?)').run(req.client.id, name, clean(req.body.address), clean(req.body.city));
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
c.patch('/locales/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM locales WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
  if (!l) return res.status(404).json({ error: 'Local no encontrado' });
  const b = req.body || {};
  db.prepare('UPDATE locales SET name=?, address=?, city=? WHERE id=?')
    .run(clean(b.name) || l.name, 'address' in b ? clean(b.address) : l.address, 'city' in b ? clean(b.city) : l.city, l.id);
  res.json({ ok: true });
});
c.delete('/locales/:id', (req, res) => {
  db.prepare('DELETE FROM locales WHERE id = ? AND client_id = ?').run(Number(req.params.id), req.client.id);
  res.json({ ok: true });
});

// Empleados
function checkLocal(req, localId) {
  if (localId === null || localId === undefined || localId === '') return null;
  const l = db.prepare('SELECT id FROM locales WHERE id = ? AND client_id = ?').get(Number(localId), req.client.id);
  if (!l) throw Object.assign(new Error('Local no válido'), { status: 400 });
  return l.id;
}
c.get('/employees', (req, res) => {
  res.json(db.prepare(`SELECT e.*, l.name AS local_name FROM employees e LEFT JOIN locales l ON l.id = e.local_id
    WHERE e.client_id = ? ORDER BY e.active DESC, e.name`).all(req.client.id));
});
c.post('/employees', (req, res) => {
  const b = req.body || {};
  const name = clean(b.name);
  if (!name) return res.status(400).json({ error: 'El nombre del empleado es obligatorio' });
  const r = db.prepare('INSERT INTO employees (client_id, local_id, name, position, email, phone) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.client.id, checkLocal(req, b.local_id), name, clean(b.position), clean(b.email), clean(b.phone));
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
c.patch('/employees/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
  if (!e) return res.status(404).json({ error: 'Empleado no encontrado' });
  const b = req.body || {};
  const pick = (k, f = clean) => (k in b ? f(b[k]) : e[k]);
  db.prepare('UPDATE employees SET name=?, local_id=?, position=?, email=?, phone=?, active=? WHERE id=?')
    .run(pick('name') || e.name, 'local_id' in b ? checkLocal(req, b.local_id) : e.local_id, pick('position'), pick('email'), pick('phone'), pick('active', v => (v ? 1 : 0)), e.id);
  res.json({ ok: true });
});
c.delete('/employees/:id', (req, res) => {
  db.prepare('DELETE FROM employees WHERE id = ? AND client_id = ?').run(Number(req.params.id), req.client.id);
  res.json({ ok: true });
});

// Documentos y reconocimiento
const ALLOWED = /\.(pdf|jpe?g|png|webp|bmp|tiff?|gif|xml|txt)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.test(file.originalname)),
});

function categoryFor(direction, extracted) {
  const kind = direction === 'emitido' ? 'ingreso' : 'gasto';
  if (acc.isCategory(kind, extracted.category)) return extracted.category;
  return acc.suggestCategory(direction, { proveedor: extracted.fields?.proveedor, lines: extracted.lines, docType: extracted.doc_type });
}

function docOut(d, full) {
  const out = { ...d, extracted: JSON.parse(d.extracted_json || 'null'), corrected: JSON.parse(d.corrected_json || 'null') };
  delete out.extracted_json; delete out.corrected_json; delete out.stored_name;
  if (!full) { delete out.raw_text; if (out.extracted) { delete out.extracted.lines; delete out.extracted.all_nifs; } }
  return out;
}

async function runAnalysis(client, buffer, mime, filename, direction) {
  const r = await analyze(buffer, { mime, filename, ownNif: client.nif, ownName: client.name, direction });
  const { raw_text, ocr_confidence, method, ...extracted } = r;
  return { raw_text, ocr_confidence, method, extracted };
}

c.post('/documents', upload.single('file'), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'Archivo no válido. Formatos: PDF, JPG, PNG, WEBP, TIFF, XML o TXT (máx. 20 MB)' });
  // multer entrega el nombre en latin1
  const filename = Buffer.from(f.originalname, 'latin1').toString('utf8');
  const stored = crypto.randomUUID() + path.extname(filename).toLowerCase();
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), f.buffer);
  const started = Date.now();
  let a;
  const wanted = ['recibido', 'emitido'].includes(req.body?.direction) ? req.body.direction : null;
  try { a = await runAnalysis(req.client, f.buffer, f.mimetype, filename, wanted); }
  catch (e) {
    console.error('Error de reconocimiento:', e);
    a = { raw_text: '', ocr_confidence: null, method: 'error', extracted: { doc_type: null, fields: {}, lines: [], checks: [{ id: 'error', ok: false, msg: 'No se ha podido leer el documento: ' + e.message }], score: 0 } };
  }
  a.extracted.method = a.method;
  a.extracted.ms = Date.now() - started;
  const direction = wanted || a.extracted.direction || 'recibido';
  const r = db.prepare(`INSERT INTO documents (client_id, local_id, filename, stored_name, mime, source, doc_type, raw_text, ocr_confidence, extracted_json, direction, category)
    VALUES (?, ?, ?, ?, ?, 'subida', ?, ?, ?, ?, ?, ?)`)
    .run(req.client.id, checkLocal(req, req.body?.local_id), filename, stored, f.mimetype, a.extracted.doc_type, a.raw_text, a.ocr_confidence, JSON.stringify(a.extracted),
      direction, categoryFor(direction, a.extracted));
  res.status(201).json(docOut(db.prepare('SELECT * FROM documents WHERE id = ?').get(r.lastInsertRowid), true));
});

c.get('/documents', (req, res) => {
  const type = clean(req.query.type), dir = clean(req.query.dir);
  const where = ['client_id = ?'], args = [req.client.id];
  if (type) { where.push("COALESCE(json_extract(corrected_json, '$.doc_type'), doc_type) = ?"); args.push(type); }
  if (dir === 'recibido' || dir === 'emitido') { where.push('direction = ?'); args.push(dir); }
  const rows = db.prepare(`SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...args);
  res.json(rows.map(d => docOut(d, false)));
});

function getDoc(req) {
  const d = db.prepare('SELECT * FROM documents WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
  if (!d) throw Object.assign(new Error('Documento no encontrado'), { status: 404 });
  return d;
}

c.get('/documents/:id', (req, res) => res.json(docOut(getDoc(req), true)));

c.get('/documents/:id/file', (req, res) => {
  const d = getDoc(req);
  // El tipo se decide por la extensión guardada, nunca por el mime que envió el navegador
  const ext = path.extname(d.stored_name).slice(1);
  const types = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };
  res.setHeader('Content-Type', types[ext] || 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (ext !== 'pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
  res.sendFile(path.join(UPLOAD_DIR, d.stored_name));
});

c.post('/documents/:id/reanalyze', async (req, res) => {
  const d = getDoc(req);
  const buf = fs.readFileSync(path.join(UPLOAD_DIR, d.stored_name));
  const started = Date.now();
  // Se relee con la dirección que indique la pantalla (o la guardada), para que el tercero sea el correcto
  const direction = ['recibido', 'emitido'].includes(req.body?.direction) ? req.body.direction : d.direction;
  const a = await runAnalysis(req.client, buf, d.mime, d.filename, direction);
  a.extracted.method = a.method;
  a.extracted.ms = Date.now() - started;
  db.prepare('UPDATE documents SET doc_type=?, raw_text=?, ocr_confidence=?, extracted_json=?, direction=? WHERE id=?')
    .run(a.extracted.doc_type, a.raw_text, a.ocr_confidence, JSON.stringify(a.extracted), direction || a.extracted.direction || 'recibido', d.id);
  res.json(docOut(getDoc(req), true));
});

const FIELD_KEYS = ['proveedor', 'nif', 'numero', 'fecha', 'vencimiento', 'base', 'iva_tipo', 'iva', 'recargo', 'retencion', 'total', 'forma_pago', 'iban'];
const NUM_KEYS = new Set(['base', 'iva_tipo', 'iva', 'recargo', 'retencion', 'total']);

c.put('/documents/:id/validate', (req, res) => {
  const d = getDoc(req);
  const b = req.body || {};
  const fields = {};
  for (const k of FIELD_KEYS) {
    const v = b.fields?.[k];
    if (NUM_KEYS.has(k)) {
      const n = v === '' || v === null || v === undefined ? null : Number(String(v).replace(',', '.'));
      fields[k] = Number.isFinite(n) ? n : null;
    } else fields[k] = clean(v);
  }
  const direction = ['recibido', 'emitido'].includes(b.direction) ? b.direction : d.direction;
  const corrected = { doc_type: clean(b.doc_type) || d.doc_type, direction, fields, note: clean(b.note) };
  const kind = direction === 'emitido' ? 'ingreso' : 'gasto';
  const category = acc.isCategory(kind, b.category) ? b.category : (acc.isCategory(kind, d.category) ? d.category : categoryFor(direction, { ...JSON.parse(d.extracted_json || '{}'), fields }));
  const paid = 'paid' in b ? (b.paid ? 1 : 0) : d.paid;
  db.prepare(`UPDATE documents SET corrected_json=?, status='validado', validated_at=datetime('now'), local_id=?, direction=?, category=?, paid=?,
    paid_at = CASE WHEN ? = 1 THEN COALESCE(paid_at, datetime('now')) ELSE NULL END WHERE id=?`)
    .run(JSON.stringify(corrected), 'local_id' in b ? checkLocal(req, b.local_id) : d.local_id, direction, category, paid, paid, d.id);
  res.json(docOut(getDoc(req), true));
});

// Cambios rápidos desde los listados: cobrado/pagado, categoría, recibido/emitido
c.patch('/documents/:id', (req, res) => {
  const d = getDoc(req);
  const b = req.body || {};
  const direction = ['recibido', 'emitido'].includes(b.direction) ? b.direction : d.direction;
  const kind = direction === 'emitido' ? 'ingreso' : 'gasto';
  let category = d.category;
  if ('category' in b) {
    if (!acc.isCategory(kind, b.category)) return res.status(400).json({ error: 'Categoría no válida' });
    category = b.category;
  } else if (direction !== d.direction) category = categoryFor(direction, JSON.parse(d.extracted_json || '{}'));
  const paid = 'paid' in b ? (b.paid ? 1 : 0) : d.paid;
  db.prepare(`UPDATE documents SET direction=?, category=?, paid=?, paid_at = CASE WHEN ? = 1 THEN COALESCE(paid_at, datetime('now')) ELSE NULL END WHERE id=?`)
    .run(direction, category, paid, paid, d.id);
  res.json(docOut(getDoc(req), false));
});

// ---------------------------------------------------------------- contabilidad
function accountingEntries(clientId, onlyValidated) {
  const docs = db.prepare(`SELECT * FROM documents WHERE client_id = ?${onlyValidated ? " AND status = 'validado'" : ''}`).all(clientId)
    .map(d => acc.docToEntry({ ...d, extracted: JSON.parse(d.extracted_json || 'null'), corrected: JSON.parse(d.corrected_json || 'null') }))
    .filter(Boolean);
  const manual = db.prepare('SELECT * FROM entries WHERE client_id = ?').all(clientId).map(acc.manualToEntry);
  return [...docs, ...manual];
}
function periodFrom(q) {
  const year = Number(q.year) || new Date().getFullYear();
  const quarter = [1, 2, 3, 4].includes(Number(q.quarter)) ? Number(q.quarter) : null;
  const month = Number(q.month) >= 1 && Number(q.month) <= 12 ? Number(q.month) : null;
  return { year, quarter: month ? null : quarter, month };
}
c.get('/categories', (req, res) => res.json(acc.CATEGORIES));
c.get('/accounting', (req, res) => {
  const all = accountingEntries(req.client.id, req.query.validated === '1');
  const years = [...new Set(all.map(e => Number(e.date.slice(0, 4))).filter(Boolean))].sort((a, b) => b - a);
  res.json({ ...acc.compute(all, periodFrom(req.query)), years, catalog: acc.CATEGORIES });
});
c.get('/accounting.csv', (req, res) => {
  const p = periodFrom(req.query);
  const r = acc.compute(accountingEntries(req.client.id, req.query.validated === '1'), p);
  const name = `libro-ingresos-gastos-${p.year}${p.quarter ? '-T' + p.quarter : ''}${p.month ? '-' + String(p.month).padStart(2, '0') : ''}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(acc.toCsv(r.entries));
});

// Apuntes manuales: gastos e ingresos sin documento (nóminas, alquiler, cuotas…)
function entryFromBody(b, prev = {}) {
  const kind = b.kind === 'ingreso' || b.kind === 'gasto' ? b.kind : prev.kind;
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? b.fecha : acc.toIso(b.fecha) || prev.fecha;
  const concepto = clean(b.concepto) ?? prev.concepto;
  const n = v => { const x = v === '' || v === null || v === undefined ? null : Number(String(v).replace(',', '.')); return Number.isFinite(x) ? x : null; };
  const base = 'base' in b ? n(b.base) : prev.base;
  const iva = 'iva' in b ? (n(b.iva) ?? 0) : (prev.iva ?? 0);
  const retencion = 'retencion' in b ? (n(b.retencion) ?? 0) : (prev.retencion ?? 0);
  if (!kind) throw Object.assign(new Error('Indica si es un gasto o un ingreso'), { status: 400 });
  if (!fecha) throw Object.assign(new Error('La fecha no es válida'), { status: 400 });
  if (!concepto) throw Object.assign(new Error('El concepto es obligatorio'), { status: 400 });
  if (base === null) throw Object.assign(new Error('El importe es obligatorio'), { status: 400 });
  const category = acc.isCategory(kind, b.category) ? b.category : (acc.isCategory(kind, prev.category) ? prev.category : (kind === 'gasto' ? 'otros_gastos' : 'otros_ingresos'));
  return { kind, fecha, concepto, category, tercero: 'tercero' in b ? clean(b.tercero) : prev.tercero ?? null, base, iva, retencion,
    total: Math.round((base + iva - retencion) * 100) / 100, paid: 'paid' in b ? (b.paid ? 1 : 0) : (prev.paid ?? 1) };
}
c.get('/entries', (req, res) => res.json(db.prepare('SELECT * FROM entries WHERE client_id = ? ORDER BY fecha DESC, id DESC').all(req.client.id)));
c.post('/entries', (req, res) => {
  const e = entryFromBody(req.body || {});
  const r = db.prepare('INSERT INTO entries (client_id, kind, fecha, concepto, category, tercero, base, iva, retencion, total, paid) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(req.client.id, e.kind, e.fecha, e.concepto, e.category, e.tercero, e.base, e.iva, e.retencion, e.total, e.paid);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
c.patch('/entries/:id', (req, res) => {
  const prev = db.prepare('SELECT * FROM entries WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
  if (!prev) return res.status(404).json({ error: 'Apunte no encontrado' });
  const e = entryFromBody(req.body || {}, prev);
  db.prepare('UPDATE entries SET kind=?, fecha=?, concepto=?, category=?, tercero=?, base=?, iva=?, retencion=?, total=?, paid=? WHERE id=?')
    .run(e.kind, e.fecha, e.concepto, e.category, e.tercero, e.base, e.iva, e.retencion, e.total, e.paid, prev.id);
  res.json({ ok: true });
});
c.delete('/entries/:id', (req, res) => {
  db.prepare('DELETE FROM entries WHERE id = ? AND client_id = ?').run(Number(req.params.id), req.client.id);
  res.json({ ok: true });
});

c.delete('/documents/:id', (req, res) => {
  const d = getDoc(req);
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  fs.rm(path.join(UPLOAD_DIR, d.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

// Precisión: compara lo extraído automáticamente con lo validado por una persona
const normText = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function sameValue(k, a, b) {
  if (NUM_KEYS.has(k)) return a !== null && b !== null && a !== undefined && b !== undefined && Math.abs(Number(a) - Number(b)) < 0.011;
  return normText(a) === normText(b);
}
function accuracyFor(clientId) {
  const docs = db.prepare("SELECT id, filename, extracted_json, corrected_json FROM documents WHERE client_id = ? AND status = 'validado'").all(clientId);
  const per = Object.fromEntries(['doc_type', 'direction', ...FIELD_KEYS].map(k => [k, { ok: 0, wrong: 0, missing: 0, extra: 0 }]));
  const detail = [];
  let ok = 0, total = 0;
  for (const d of docs) {
    const ex = JSON.parse(d.extracted_json || '{}'), co = JSON.parse(d.corrected_json || '{}');
    const row = { id: d.id, filename: d.filename, fields: {} };
    const pairs = [['doc_type', ex.doc_type, co.doc_type], ['direction', ex.direction ?? null, co.direction ?? null], ...FIELD_KEYS.map(k => [k, ex.fields?.[k] ?? null, co.fields?.[k] ?? null])];
    for (const [k, a, b] of pairs) {
      const emptyA = a === null || a === '', emptyB = b === null || b === '';
      let s;
      if (emptyA && emptyB) continue;
      if (emptyB) s = 'extra';
      else if (emptyA) s = 'missing';
      else s = sameValue(k, a, b) ? 'ok' : 'wrong';
      per[k][s]++;
      row.fields[k] = s;
      if (s !== 'extra') { total++; if (s === 'ok') ok++; }
    }
    detail.push(row);
  }
  return { documents: docs.length, overall: total ? Math.round(ok / total * 1000) / 10 : null, per, detail };
}
c.get('/accuracy', (req, res) => res.json(accuracyFor(req.client.id)));

app.use('/api/c', c);

// ---------------------------------------------------------------- páginas

const pub = p => path.join(__dirname, 'public', p);
app.get('/icons.svg', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('lucide-static/sprite.svg'));
});
app.get('/', (req, res) => res.redirect(!req.user ? '/login' : req.user.role === 'admin' ? '/admin' : '/app'));
app.get('/login', (req, res) => req.user ? res.redirect('/') : res.sendFile(pub('login.html')));
app.get('/admin', (req, res) => req.user?.role === 'admin' ? res.sendFile(pub('admin.html')) : res.redirect('/login'));
app.get('/app', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.role === 'admin' && !req.query.cid) return res.redirect('/admin');
  res.sendFile(pub('app.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
});

const URL_APP = `http://localhost:${PORT}`;
// Abre el navegador cuando el servidor ya escucha (GESTY_OPEN=1 lo pone "Iniciar Gesty.bat")
function openBrowser() {
  if (process.env.GESTY_OPEN !== '1') return;
  const { spawn } = require('node:child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', URL_APP]] : process.platform === 'darwin' ? ['open', [URL_APP]] : ['xdg-open', [URL_APP]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
}
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Gesty Management está funcionando en ${URL_APP}`);
  console.log('  Deja esta ventana abierta mientras lo uses. Para cerrarlo, cierra la ventana o pulsa Ctrl+C.\n');
  openBrowser();
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  El puerto ${PORT} ya está en uso: probablemente Gesty ya está abierto en otra ventana.`);
    console.log(`  Abriendo ${URL_APP} en el navegador…\n`);
    openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else { console.error(e); process.exit(1); }
});
