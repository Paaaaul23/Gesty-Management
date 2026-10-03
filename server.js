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
const fiscal = require('./fiscal');
const sales = require('./sales');

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

// Trazabilidad: registro de cada acción (quién, cuándo, qué)
function audit(req, action, entity = null, entityId = null, detail = null) {
  try {
    db.prepare('INSERT INTO audit_log (client_id, user_id, user_name, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.client?.id ?? null, req.user?.id ?? null, req.user ? (req.user.role === 'admin' ? `${req.user.name} (administrador)` : req.user.name) : null,
        action, entity, entityId, detail === null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail));
  } catch (e) { console.error('No se pudo registrar la actividad:', e.message); }
}

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
    pending: one("SELECT COUNT(*) n FROM documents WHERE client_id = ? AND status = 'pendiente' AND COALESCE(source, '') <> 'creado'").n,
    byType: db.prepare("SELECT COALESCE(json_extract(corrected_json, '$.doc_type'), doc_type, 'otro') t, COUNT(*) n FROM documents WHERE client_id = ? GROUP BY t").all(id),
    byDirection: db.prepare("SELECT direction d, COUNT(*) n FROM documents WHERE client_id = ? GROUP BY direction").all(id),
    finance: (() => {
      // Año en curso; si aún no tiene movimientos, el último año que sí los tenga
      const all = accountingEntries(req.client, false);
      const years = all.map(e => Number(e.date.slice(0, 4))).filter(Boolean);
      const now = new Date().getFullYear();
      const year = years.includes(now) || !years.length ? now : Math.max(...years);
      const r = acc.compute(all, { year });
      const profile = fiscal.profileOf(req.client);
      const filings = db.prepare('SELECT * FROM tax_filings WHERE client_id = ?').all(id);
      const today = new Date().toISOString().slice(0, 10);
      const cal = [...(years.includes(now - 1) ? fiscal.calendar(all, profile, now - 1, filings) : []), ...fiscal.calendar(all, profile, now, filings)].filter(o => o.required && !o.status && o.deadline >= `${now}-01-01`);
      const next = cal.filter(o => o.deadline >= today).sort((a, b) => a.deadline.localeCompare(b.deadline))[0] || null;
      return { year, ...r.totals, porCobrar: r.pending.porCobrar.total, porPagar: r.pending.porPagar.total,
        reserva: fiscal.reserve(cal, profile).total, next: next && { modelo: next.modelo, name: next.name, period: next.period, deadline: next.deadline, result: next.result } };
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
  const pick = k => (k in b ? clean(b[k]) : req.client[k]);
  db.prepare('UPDATE clients SET name=?, nif=?, email=?, phone=?, address=?, postal_city=?, iban=?, doc_footer=? WHERE id=?')
    .run(name, clean(b.nif)?.toUpperCase().replace(/[\s.\-]/g, '') || null, clean(b.email), clean(b.phone), pick('address'), pick('postal_city'), pick('iban'), pick('doc_footer'), req.client.id);
  audit(req, 'Datos de la empresa actualizados', 'empresa', req.client.id);
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
  const out = { ...d, extracted: JSON.parse(d.extracted_json || 'null'), corrected: JSON.parse(d.corrected_json || 'null'), draft: JSON.parse(d.draft_json || 'null') };
  delete out.extracted_json; delete out.corrected_json; delete out.stored_name; delete out.draft_json;
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
  const newId = Number(r.lastInsertRowid);
  audit(req, `Documento subido y leído (${a.extracted.engine === 'ia' ? 'con IA' : 'lectura local'})`, 'documento', newId, `${filename} · ${a.extracted.doc_type || 'sin tipo'} ${direction}`);
  autoLink(req, newId);
  res.status(201).json(docOut(db.prepare('SELECT * FROM documents WHERE id = ?').get(newId), true));
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
  audit(req, 'Documento leído de nuevo', 'documento', d.id);
  autoLink(req, d.id);
  res.json(docOut(getDoc(req), true));
});

const FIELD_KEYS = ['proveedor', 'nif', 'numero', 'fecha', 'vencimiento', 'base', 'iva_tipo', 'iva', 'recargo', 'retencion', 'total', 'forma_pago', 'iban'];
const NUM_KEYS = new Set(['base', 'iva_tipo', 'iva', 'recargo', 'retencion', 'total']);

// ---------------------------------------------------------------- terceros conocidos (agenda + historial)
const normNif = v => { const x = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^ES(?=[A-Z0-9]{9}$)/, ''); return x || null; };
const LEGAL_FORMS = new Set(['sl', 'slu', 'sll', 'slne', 'sa', 'sau', 'sc', 'scoop', 'cb', 'scp']);
function normName(v) {
  const words = String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words.at(-1))) words.pop();
  return words.join('');
}
// Mismo NIF/CIF, o mismo nombre cuando alguno de los dos no tiene NIF (con NIF distinto no es el mismo)
function findParty(list, nif, name) {
  const n = normNif(nif);
  if (n) { const byNif = list.find(p => normNif(p.nif) === n); if (byNif) return byNif; }
  const nm = normName(name);
  if (!nm) return null;
  return list.find(p => normName(p.name) === nm && (!n || !normNif(p.nif))) || null;
}
// Proveedores y clientes ya conocidos: la agenda y los terceros de los documentos validados
function knownParties(clientId) {
  const out = db.prepare('SELECT id, kind, name, nif FROM contacts WHERE client_id = ? ORDER BY name COLLATE NOCASE').all(clientId)
    .map(c => ({ contact_id: c.id, kind: c.kind, name: c.name, nif: c.nif, source: 'agenda', docs: 0 }));
  for (const d of db.prepare("SELECT direction, contact_id, corrected_json FROM documents WHERE client_id = ? AND status = 'validado'").all(clientId)) {
    const f = JSON.parse(d.corrected_json || '{}').fields || {};
    if (!f.proveedor) continue;
    let p = (d.contact_id && out.find(x => x.contact_id === d.contact_id)) || findParty(out, f.nif, f.proveedor);
    if (!p) { p = { contact_id: null, kind: d.direction === 'emitido' ? 'cliente' : 'proveedor', name: f.proveedor, nif: normNif(f.nif), source: 'historial', docs: 0 }; out.push(p); }
    p.docs++;
  }
  return out;
}
c.get('/parties', (req, res) => res.json(knownParties(req.client.id)));

const FIELD_NAMES = { proveedor: 'Proveedor / cliente', nif: 'NIF / CIF', numero: 'Número', fecha: 'Fecha', vencimiento: 'Vencimiento', base: 'Base imponible', iva_tipo: 'Tipo IVA %', iva: 'Cuota IVA', recargo: 'Recargo de equivalencia', retencion: 'Retención IRPF', total: 'Total', forma_pago: 'Forma de pago', iban: 'IBAN' };

// Registro en texto de cada validación, guardado junto al archivo original
const recordPath = d => path.join(UPLOAD_DIR, d.stored_name + '.registro.txt');
function writeRecord(req, d, { changed, contact, newContact }) {
  const co = JSON.parse(d.corrected_json || '{}'), ex = JSON.parse(d.extracted_json || '{}');
  const f = co.fields || {};
  const local = d.local_id ? db.prepare('SELECT name FROM locales WHERE id = ?').get(d.local_id)?.name : null;
  const party = d.direction === 'emitido' ? 'Cliente' : 'Proveedor';
  const txt = [
    '='.repeat(72),
    `REGISTRO DE VALIDACIÓN · Gesty Management`,
    '='.repeat(72),
    `Empresa:            ${req.client.name}${req.client.nif ? ' (' + req.client.nif + ')' : ''}`,
    `Documento interno:  ${d.id}`,
    `Archivo original:   ${d.filename} (guardado como ${d.stored_name})`,
    `Subido el:          ${d.created_at} UTC`,
    `Validado por:       ${d.validated_by}`,
    `Validado el:        ${d.validated_at} UTC`,
    `Tipo:               ${co.doc_type || d.doc_type || 'sin clasificar'} ${d.direction}`,
    `${party}:${' '.repeat(19 - party.length)}${f.proveedor || '—'}${contact ? ` · ficha nº ${contact.id} de la agenda${newContact ? ' (creada al validar)' : ' (existente)'}` : ''}`,
    `Categoría:          ${acc.CATEGORY_LABEL[d.category] || d.category || '—'}`,
    `Pago:               ${d.paid ? (d.direction === 'emitido' ? 'cobrado' : 'pagado') : 'pendiente'}`,
    `Local:              ${local || 'sin asignar'}`,
    '',
    'DATOS VALIDADOS',
    ...FIELD_KEYS.map(k => `  ${(FIELD_NAMES[k] + ':').padEnd(26)}${f[k] ?? '—'}`),
    ...(co.note ? ['', `Nota: ${co.note}`] : []),
    '',
    'CORRECCIONES SOBRE LA LECTURA AUTOMÁTICA',
    ...(changed.length ? changed.map(x => '  ' + x) : ['  Ninguna: todos los campos leídos eran correctos']),
    '',
    'COMPROBACIONES AUTOMÁTICAS',
    ...((ex.checks || []).length ? ex.checks.map(x => `  [${x.warn ? '!' : x.ok ? 'OK' : 'X'}] ${x.msg}`) : ['  —']),
    '',
    '-'.repeat(72),
    'TEXTO LEÍDO DEL DOCUMENTO',
    '-'.repeat(72),
    d.raw_text || '(sin texto)',
    '', '',
  ].join('\r\n');
  fs.appendFileSync(recordPath(d), (fs.existsSync(recordPath(d)) ? '' : '﻿') + txt);
}

c.put('/documents/:id/validate', (req, res) => {
  const d = getDoc(req);
  if (d.source === 'creado') return res.status(400).json({ error: 'Este documento se creó en Gesty: modifícalo desde su editor' });
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
  const role = direction === 'emitido' ? 'cliente' : 'proveedor';

  // Proveedor / cliente: se guarda contra el de la agenda o el historial; uno nuevo solo con confirmación
  let contact = null, newContact = false;
  if (fields.proveedor) {
    const want = b.party || {};
    if (want.contact_id) {
      contact = db.prepare('SELECT * FROM contacts WHERE id = ? AND client_id = ?').get(Number(want.contact_id), req.client.id);
      if (!contact) return res.status(400).json({ error: `El ${role} elegido no existe` });
    } else {
      const known = findParty(knownParties(req.client.id), fields.nif, fields.proveedor);
      if (known?.contact_id) contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(known.contact_id);
      else if (!known && !want.create)
        return res.status(409).json({ error: `${fields.proveedor} no está en tu historial: confirma que quieres crear un ${role} nuevo`, needs_party_confirmation: true, party: { name: fields.proveedor, nif: fields.nif, role } });
      if (!contact) {
        // Nuevo (confirmado) o conocido solo por documentos anteriores: se da de alta en la agenda
        const src = known || { name: fields.proveedor, nif: fields.nif };
        const r = db.prepare('INSERT INTO contacts (client_id, kind, name, nif) VALUES (?, ?, ?, ?)').run(req.client.id, role, src.name, normNif(src.nif) || normNif(fields.nif));
        contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(r.lastInsertRowid));
        newContact = !known;
        audit(req, newContact ? `${role === 'cliente' ? 'Cliente' : 'Proveedor'} nuevo creado al validar` : `${role === 'cliente' ? 'Cliente' : 'Proveedor'} del historial añadido a la agenda`, 'contacto', contact.id, `${contact.name}${contact.nif ? ' · ' + contact.nif : ''}`);
      }
    }
    // Completa la ficha (NIF que faltaba, cliente y proveedor a la vez)
    const nif = contact.nif || normNif(fields.nif);
    const kind = contact.kind === role || contact.kind === 'ambos' ? contact.kind : 'ambos';
    if (nif !== contact.nif || kind !== contact.kind) { db.prepare('UPDATE contacts SET nif = ?, kind = ? WHERE id = ?').run(nif, kind, contact.id); Object.assign(contact, { nif, kind }); }
    fields.proveedor = contact.name;
    fields.nif = contact.nif || fields.nif;
  }

  const corrected = { doc_type: clean(b.doc_type) || d.doc_type, direction, fields, note: clean(b.note) };
  const kind = direction === 'emitido' ? 'ingreso' : 'gasto';
  const category = acc.isCategory(kind, b.category) ? b.category : (acc.isCategory(kind, d.category) ? d.category : categoryFor(direction, { ...JSON.parse(d.extracted_json || '{}'), fields }));
  const paid = 'paid' in b ? (b.paid ? 1 : 0) : d.paid;
  const who = req.user.role === 'admin' ? `${req.user.name} (administrador)` : req.user.name;
  db.prepare(`UPDATE documents SET corrected_json=?, status='validado', validated_at=datetime('now'), validated_by=?, contact_id=?, local_id=?, direction=?, category=?, paid=?,
    paid_at = CASE WHEN ? = 1 THEN COALESCE(paid_at, datetime('now')) ELSE NULL END WHERE id=?`)
    .run(JSON.stringify(corrected), who, contact?.id ?? null, 'local_id' in b ? checkLocal(req, b.local_id) : d.local_id, direction, category, paid, paid, d.id);
  const prev = (JSON.parse(d.corrected_json || 'null') || JSON.parse(d.extracted_json || '{}')).fields || {};
  const changed = FIELD_KEYS.filter(k => String(prev[k] ?? '') !== String(fields[k] ?? '')).map(k => `${k}: ${prev[k] ?? '—'} → ${fields[k] ?? '—'}`);
  audit(req, d.status === 'validado' ? 'Datos corregidos' : 'Documento validado', 'documento', d.id,
    [changed.length ? changed.join('; ') : 'sin cambios', contact ? `${role}: ${contact.name}${newContact ? ' (nuevo)' : ''}` : null].filter(Boolean).join(' · '));
  const saved = getDoc(req);
  try { writeRecord(req, saved, { changed, contact, newContact }); } catch (e) { console.error('No se pudo guardar el registro en texto:', e.message); }
  res.json(docOut(saved, true));
});

// Registro en texto de las validaciones del documento
c.get('/documents/:id/record', (req, res) => {
  const d = getDoc(req);
  if (!fs.existsSync(recordPath(d))) return res.status(404).json({ error: 'Este documento todavía no se ha validado' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.filename.replace(/\.[^.]+$/, '') + ' - registro.txt')}`);
  res.sendFile(recordPath(d));
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
  const what = [];
  if ('paid' in b && !!b.paid !== !!d.paid) what.push(b.paid ? (direction === 'emitido' ? 'marcado como cobrado' : 'marcado como pagado') : 'marcado como pendiente');
  if (direction !== d.direction) what.push(`cambiado a ${direction}`);
  if (category !== d.category) what.push(`categoría: ${acc.CATEGORY_LABEL[category] || category}`);
  if (what.length) audit(req, 'Documento actualizado', 'documento', d.id, what.join('; '));
  res.json(docOut(getDoc(req), false));
});

// ---------------------------------------------------------------- contabilidad
function accountingEntries(client, onlyValidated) {
  const clientId = client.id;
  const ownNif = client.nif ? client.nif.toUpperCase().replace(/[\s.\-]/g, '').replace(/^ES/, '') : null;
  // Los documentos capturados solo cuentan cuando una persona los ha validado
  const docs = db.prepare(`SELECT * FROM documents WHERE client_id = ? AND COALESCE(doc_state, '') <> 'borrador' AND (source = 'creado' OR status = 'validado')${onlyValidated ? " AND status = 'validado'" : ''}`).all(clientId)
    .map(d => acc.docToEntry({ ...d, extracted: JSON.parse(d.extracted_json || 'null'), corrected: JSON.parse(d.corrected_json || 'null') }, { ownNif }))
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
  const all = accountingEntries(req.client, req.query.validated === '1');
  const years = [...new Set(all.map(e => Number(e.date.slice(0, 4))).filter(Boolean))].sort((a, b) => b - a);
  const pendingCaptures = db.prepare("SELECT COUNT(*) n FROM documents WHERE client_id = ? AND COALESCE(source, '') <> 'creado' AND status <> 'validado'").get(req.client.id).n;
  res.json({ ...acc.compute(all, periodFrom(req.query)), years, catalog: acc.CATEGORIES, pendingCaptures });
});
c.get('/accounting.csv', (req, res) => {
  const p = periodFrom(req.query);
  const r = acc.compute(accountingEntries(req.client, req.query.validated === '1'), p);
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
  audit(req, 'Apunte manual creado', 'apunte', Number(r.lastInsertRowid), `${e.kind} · ${e.concepto} · ${e.total} €`);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
c.patch('/entries/:id', (req, res) => {
  const prev = db.prepare('SELECT * FROM entries WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
  if (!prev) return res.status(404).json({ error: 'Apunte no encontrado' });
  const e = entryFromBody(req.body || {}, prev);
  db.prepare('UPDATE entries SET kind=?, fecha=?, concepto=?, category=?, tercero=?, base=?, iva=?, retencion=?, total=?, paid=? WHERE id=?')
    .run(e.kind, e.fecha, e.concepto, e.category, e.tercero, e.base, e.iva, e.retencion, e.total, e.paid, prev.id);
  audit(req, 'Apunte manual modificado', 'apunte', prev.id, `${e.concepto} · ${e.total} €`);
  res.json({ ok: true });
});
c.delete('/entries/:id', (req, res) => {
  const r = db.prepare('DELETE FROM entries WHERE id = ? AND client_id = ?').run(Number(req.params.id), req.client.id);
  if (r.changes) audit(req, 'Apunte manual eliminado', 'apunte', Number(req.params.id));
  res.json({ ok: true });
});

c.delete('/documents/:id', (req, res) => {
  const d = getDoc(req);
  if (d.source === 'creado' && ['factura', 'rectificativa'].includes(d.doc_type) && d.doc_state !== 'borrador')
    return res.status(400).json({ error: 'Una factura emitida no se puede borrar (numeración correlativa). Emite una factura rectificativa.' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  fs.rm(path.join(UPLOAD_DIR, d.stored_name), { force: true }, () => {});
  fs.rm(recordPath(d), { force: true }, () => {});
  audit(req, 'Documento eliminado', 'documento', d.id, d.filename);
  res.json({ ok: true });
});

// Precisión: compara lo extraído automáticamente con lo validado por una persona
const normText = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function sameValue(k, a, b) {
  if (NUM_KEYS.has(k)) return a !== null && b !== null && a !== undefined && b !== undefined && Math.abs(Number(a) - Number(b)) < 0.011;
  return normText(a) === normText(b);
}
function accuracyFor(clientId) {
  const docs = db.prepare("SELECT id, filename, extracted_json, corrected_json FROM documents WHERE client_id = ? AND status = 'validado' AND COALESCE(source, '') <> 'creado'").all(clientId);
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

// ---------------------------------------------------------------- trazabilidad: documentos relacionados
const docNumber = d => { const j = JSON.parse(d.corrected_json || 'null') || JSON.parse(d.extracted_json || '{}'); return j?.fields?.numero || null; };
const flatTxt = t => String(t || '').toUpperCase().replace(/[\s.]/g, '');
// Enlaza automáticamente documentos que se citan entre sí ("Su pedido: PED-0921", "Albarán 24/1532"…)
function autoLink(req, id) {
  const me = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!me) return;
  const myNum = docNumber(me), myText = flatTxt(me.raw_text);
  const others = db.prepare('SELECT id, raw_text, extracted_json, corrected_json FROM documents WHERE client_id = ? AND id <> ?').all(me.client_id, id);
  const ok = n => n && n.length >= 4 && /\d/.test(n);
  for (const o of others) {
    const oNum = docNumber(o);
    const cites = (ok(oNum) && myText.includes(flatTxt(oNum))) || (ok(myNum) && flatTxt(o.raw_text).includes(flatTxt(myNum)));
    if (!cites || (oNum && myNum && flatTxt(oNum) === flatTxt(myNum))) continue;
    const r = db.prepare('INSERT OR IGNORE INTO doc_links (client_id, from_id, to_id, auto) VALUES (?, ?, ?, 1)').run(me.client_id, Math.min(id, o.id), Math.max(id, o.id));
    if (r.changes) audit(req, 'Documentos relacionados automáticamente', 'documento', id, `con el documento ${oNum || o.id}`);
  }
}
function linkedDocs(clientId, id) {
  return db.prepare(`SELECT d.id, d.filename, d.doc_type, d.direction, d.status, d.created_at, d.extracted_json, d.corrected_json, l.auto FROM doc_links l
      JOIN documents d ON d.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
      WHERE l.client_id = ? AND (l.from_id = ? OR l.to_id = ?)`).all(id, clientId, id, id)
    .map(d => { const j = JSON.parse(d.corrected_json || 'null') || JSON.parse(d.extracted_json || '{}'); return { id: d.id, filename: d.filename, doc_type: j.doc_type || d.doc_type, direction: d.direction, status: d.status, auto: !!d.auto, numero: j.fields?.numero, fecha: j.fields?.fecha, tercero: j.fields?.proveedor, total: j.fields?.total }; });
}
c.get('/documents/:id/links', (req, res) => { const d = getDoc(req); res.json(linkedDocs(req.client.id, d.id)); });
c.post('/documents/:id/links', (req, res) => {
  const d = getDoc(req);
  const other = db.prepare('SELECT id FROM documents WHERE id = ? AND client_id = ?').get(Number(req.body?.to_id), req.client.id);
  if (!other || other.id === d.id) return res.status(400).json({ error: 'Documento no válido' });
  db.prepare('INSERT OR IGNORE INTO doc_links (client_id, from_id, to_id, auto) VALUES (?, ?, ?, 0)').run(req.client.id, Math.min(d.id, other.id), Math.max(d.id, other.id));
  audit(req, 'Documentos relacionados', 'documento', d.id, `con el documento ${other.id}`);
  res.json(linkedDocs(req.client.id, d.id));
});
c.delete('/documents/:id/links/:other', (req, res) => {
  const d = getDoc(req), o = Number(req.params.other);
  db.prepare('DELETE FROM doc_links WHERE client_id = ? AND from_id = ? AND to_id = ?').run(req.client.id, Math.min(d.id, o), Math.max(d.id, o));
  audit(req, 'Relación entre documentos eliminada', 'documento', d.id, `con el documento ${o}`);
  res.json(linkedDocs(req.client.id, d.id));
});
c.get('/documents/:id/history', (req, res) => {
  const d = getDoc(req);
  res.json(db.prepare("SELECT * FROM audit_log WHERE client_id = ? AND entity = 'documento' AND entity_id = ? ORDER BY id DESC").all(req.client.id, d.id));
});
c.get('/activity', (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const entity = clean(req.query.entity);
  const rows = entity
    ? db.prepare('SELECT * FROM audit_log WHERE client_id = ? AND entity = ? ORDER BY id DESC LIMIT ?').all(req.client.id, entity, limit)
    : db.prepare('SELECT * FROM audit_log WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(req.client.id, limit);
  res.json(rows);
});

// ---------------------------------------------------------------- fiscalidad
const yearsOf = entries => [...new Set(entries.map(e => Number(e.date.slice(0, 4))).filter(Boolean))];
const filingsOf = clientId => db.prepare('SELECT * FROM tax_filings WHERE client_id = ?').all(clientId);
c.get('/fiscal/profile', (req, res) => res.json(fiscal.profileOf(req.client)));
c.put('/fiscal/profile', (req, res) => {
  const next = { ...fiscal.profileOf(req.client), ...fiscal.cleanProfile(req.body || {}) };
  delete next.configured;
  db.prepare('UPDATE clients SET fiscal_json = ? WHERE id = ?').run(JSON.stringify(next), req.client.id);
  audit(req, 'Perfil fiscal actualizado', 'empresa', req.client.id, `${next.forma} · IVA ${next.regimen_iva}`);
  res.json({ ...next, configured: true });
});
c.get('/fiscal', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const profile = fiscal.profileOf(req.client);
  const entries = accountingEntries(req.client, false);
  const cal = fiscal.calendar(entries, profile, year, filingsOf(req.client.id));
  // También lo pendiente del año anterior (4.º trimestre y anuales se presentan en enero-julio)
  const hasPrev = entries.some(e => e.date.startsWith(String(year - 1)));
  const prevCal = hasPrev ? fiscal.calendar(entries, profile, year - 1, filingsOf(req.client.id)).filter(o => o.deadline >= `${year}-01-01` && o.required && !o.status) : [];
  const all = [...prevCal.map(o => ({ ...o, prevYear: true })), ...cal];
  const today = new Date().toISOString().slice(0, 10);
  const next = all.filter(o => o.required && !o.status && o.deadline >= today).sort((a, b) => a.deadline.localeCompare(b.deadline))[0] || null;
  const years = [...new Set(entries.map(e => Number(e.date.slice(0, 4))).filter(Boolean).concat(new Date().getFullYear()))].sort((a, b) => b - a);
  res.json({ year, years, profile, calendar: all, reserve: fiscal.reserve(all, profile), next, sinValidar: entries.filter(e => e.source === 'doc' && !e.validated && e.date.startsWith(String(year))).length });
});
c.post('/fiscal/filings', (req, res) => {
  const b = req.body || {};
  if (!fiscal.MODELS[b.modelo] || !Number(b.year) || !/^(\dT|\dP|0A)$/.test(String(b.period))) return res.status(400).json({ error: 'Modelo o periodo no válido' });
  const status = b.status === 'domiciliado' ? 'domiciliado' : 'presentado';
  db.prepare(`INSERT INTO tax_filings (client_id, modelo, year, period, status, presented_at, justificante, amount, notes, snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(client_id, modelo, year, period) DO UPDATE SET status=excluded.status, presented_at=excluded.presented_at, justificante=excluded.justificante, amount=excluded.amount, notes=excluded.notes, snapshot_json=excluded.snapshot_json`)
    .run(req.client.id, String(b.modelo), Number(b.year), String(b.period), status, clean(b.presented_at) || new Date().toISOString().slice(0, 10), clean(b.justificante),
      Number.isFinite(Number(b.amount)) ? Number(b.amount) : null, clean(b.notes), b.snapshot ? JSON.stringify(b.snapshot) : null);
  audit(req, `Modelo ${b.modelo} marcado como ${status}`, 'impuesto', null, `${b.period} ${b.year}${b.justificante ? ' · justificante ' + b.justificante : ''}${b.amount ? ' · ' + b.amount + ' €' : ''}`);
  res.json({ ok: true });
});
// Al empezar a usar Gesty: marcar como presentado todo lo vencido hasta hoy
c.post('/fiscal/filings/bulk', (req, res) => {
  const year = Number(req.body?.year);
  const entries = accountingEntries(req.client, false);
  const profile = fiscal.profileOf(req.client);
  const due = [year - 1, year].flatMap(y => fiscal.calendar(entries, profile, y, filingsOf(req.client.id))).filter(o => o.overdue);
  const ins = db.prepare("INSERT OR IGNORE INTO tax_filings (client_id, modelo, year, period, status, notes) VALUES (?, ?, ?, ?, 'presentado', 'Marcado en bloque como ya presentado')");
  for (const o of due) ins.run(req.client.id, o.modelo, Number(o.periodStart.slice(0, 4)), o.period);
  audit(req, 'Obligaciones vencidas marcadas como presentadas', 'impuesto', null, `${due.length} modelos`);
  res.json({ ok: true, count: due.length });
});
c.delete('/fiscal/filings', (req, res) => {
  const b = req.body || {};
  const r = db.prepare('DELETE FROM tax_filings WHERE client_id = ? AND modelo = ? AND year = ? AND period = ?').run(req.client.id, String(b.modelo), Number(b.year), String(b.period));
  if (r.changes) audit(req, `Modelo ${b.modelo} vuelve a pendiente`, 'impuesto', null, `${b.period} ${b.year}`);
  res.json({ ok: true });
});
c.get('/fiscal/deducibility', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const quarter = [1, 2, 3, 4].includes(Number(req.query.quarter)) ? Number(req.query.quarter) : null;
  const entries = accountingEntries(req.client, false);
  res.json({ year, quarter, years: yearsOf(entries), profile: fiscal.profileOf(req.client), ...fiscal.deducibilityReport(entries, fiscal.profileOf(req.client), year, quarter) });
});

// Libros registro de IVA: facturas emitidas y recibidas
c.get('/books', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const kind = req.query.kind === 'emitidas' ? 'ingreso' : 'gasto';
  const quarter = [1, 2, 3, 4].includes(Number(req.query.quarter)) ? Number(req.query.quarter) : null;
  const profile = fiscal.profileOf(req.client);
  const all = accountingEntries(req.client, false);
  const rows = all
    .filter(e => e.source === 'doc' && e.kind === kind && e.date.startsWith(String(year)) && (!quarter || Math.ceil(Number(e.date.slice(5, 7)) / 3) === quarter))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.numero).localeCompare(String(b.numero)))
    .map((e, i) => ({ orden: i + 1, ...e, ivaDeducible: kind === 'gasto' ? fiscal.deductibility(e, profile).ivaDeducible : null }));
  if (req.query.format === 'csv') {
    const dec = v => (v === null || v === undefined ? '' : String(Math.round(v * 100) / 100).replace('.', ','));
    const t = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Nº orden', 'Fecha expedición', 'Nº factura', kind === 'ingreso' ? 'Cliente' : 'Proveedor', 'NIF', 'Tipo', 'Base imponible', 'Tipo IVA %', 'Cuota IVA', 'Recargo', 'Retención', 'Total', ...(kind === 'gasto' ? ['IVA deducible'] : [])];
    const lines = rows.map(e => [e.orden, e.date.split('-').reverse().join('/'), t(e.numero), t(e.tercero), t(e.nif), e.doc_type === 'rectificativa' ? 'Rectificativa' : 'Factura',
      dec(e.base), e.ivaRate ?? '', dec(e.iva), dec(e.recargo), dec(e.retencion), dec(e.total), ...(kind === 'gasto' ? [dec(e.ivaDeducible)] : [])].join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="libro-registro-facturas-${kind === 'ingreso' ? 'emitidas' : 'recibidas'}-${year}${quarter ? '-T' + quarter : ''}.csv"`);
    return res.send('\ufeff' + [head.join(';'), ...lines].join('\r\n'));
  }
  res.json({ year, quarter, years: yearsOf(all), kind: req.query.kind === 'emitidas' ? 'emitidas' : 'recibidas', rows });
});

// ---------------------------------------------------------------- ventas y compras: documentos creados en Gesty
const companyOf = cl => ({ name: cl.name, nif: cl.nif, address: cl.address, postal_city: cl.postal_city, phone: cl.phone, email: cl.email, iban: cl.iban, doc_footer: cl.doc_footer });
const bad = msg => Object.assign(new Error(msg), { status: 400 });

async function saveCreated(req, type, draftIn, { id = null, emit = false } = {}) {
  if (!sales.TYPES[type]) throw bad('Tipo de documento no válido');
  const prev = id ? getDoc({ ...req, params: { id } }) : null;
  const d = sales.cleanDraft(draftIn, prev ? JSON.parse(prev.draft_json || '{}') : {});
  if (!d.party.name) throw bad(`Indica el ${d.role === 'proveedor' ? 'proveedor' : 'cliente'}`);
  if (!d.lines.length) throw bad('Añade al menos una línea');
  const isInv = ['factura', 'rectificativa'].includes(type);
  if (isInv && emit && !d.party.nif) throw bad('Para emitir una factura hace falta el NIF del cliente');
  if (isInv && emit && !req.client.nif) throw bad('Para emitir facturas, falta el NIF de tu empresa (el administrador puede añadirlo en la ficha del cliente)');
  const t = sales.totals(d);
  const year = Number(d.fecha.slice(0, 4));
  let { series = null, seq = null, doc_state = 'borrador', issued_at = null, hash = null, prev_hash = null } = prev || {};
  const wasIssued = prev && prev.doc_state && prev.doc_state !== 'borrador';
  if (wasIssued && isInv) throw bad('Una factura emitida no se puede modificar. Emite una factura rectificativa.');
  if (emit && !wasIssued) {
    const tx = sales.TYPES[type].prefix + year;
    const last = db.prepare("SELECT seq, draft_json FROM documents WHERE client_id = ? AND series = ? AND doc_state <> 'borrador' ORDER BY seq DESC LIMIT 1").get(req.client.id, tx);
    if (isInv && last) {
      const lastDate = JSON.parse(last.draft_json || '{}').fecha;
      if (lastDate && d.fecha < lastDate) throw bad(`La fecha no puede ser anterior a la de la última factura de la serie (${sales.numberFor(type, year, last.seq)}, ${sales.isoToEs(lastDate)}).`);
    }
    series = tx; seq = (last?.seq || 0) + 1; doc_state = 'emitido'; issued_at = new Date().toISOString();
    if (isInv) {
      prev_hash = db.prepare("SELECT hash FROM documents WHERE client_id = ? AND hash IS NOT NULL ORDER BY issued_at DESC, id DESC LIMIT 1").get(req.client.id)?.hash || null;
      hash = sales.chainHash(prev_hash, req.client, sales.numberFor(type, year, seq), d.fecha, t.total);
    }
  }
  const numero = seq ? sales.numberFor(type, Number(series.slice(-4)), seq) : null;
  const company = companyOf(req.client);
  const extracted = sales.toExtracted(type, d, t, numero);
  const pdf = await sales.renderPdf(type, d, t, { numero, company, hash });
  const stored = prev?.stored_name || crypto.randomUUID() + '.pdf';
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), pdf);
  const filename = `${sales.TYPES[type].label} ${numero || 'borrador'}${d.party.name ? ' - ' + d.party.name : ''}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
  const direction = extracted.direction;
  const category = prev?.category || categoryFor(direction, extracted);
  const vals = [type, JSON.stringify(extracted), JSON.stringify(extracted), sales.toText(type, d, t, numero, company), JSON.stringify(d), doc_state, series, seq, issued_at, hash, prev_hash,
    doc_state === 'borrador' ? 'pendiente' : 'validado', filename, direction, category];
  let docId = id;
  if (prev) {
    db.prepare(`UPDATE documents SET doc_type=?, extracted_json=?, corrected_json=?, raw_text=?, draft_json=?, doc_state=?, series=?, seq=?, issued_at=?, hash=?, prev_hash=?, status=?, filename=?, direction=?, category=?,
      validated_at = COALESCE(validated_at, CASE WHEN ? = 'validado' THEN datetime('now') END) WHERE id=?`).run(...vals, vals[11], id);
  } else {
    const r = db.prepare(`INSERT INTO documents (doc_type, extracted_json, corrected_json, raw_text, draft_json, doc_state, series, seq, issued_at, hash, prev_hash, status, filename, direction, category,
      client_id, stored_name, mime, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'application/pdf','creado')`).run(...vals, req.client.id, stored);
    docId = Number(r.lastInsertRowid);
  }
  upsertContact(req.client.id, d.party, d.role);
  const label = `${sales.TYPES[type].label} ${numero || '(borrador)'}`;
  audit(req, emit && !wasIssued ? `${label} emitido` : prev ? `${label} modificado` : `${label} creado`, 'documento', docId, `${d.party.name} · ${t.total} €`);
  autoLink(req, docId);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
}

function upsertContact(clientId, p, role) {
  if (!p?.name) return;
  const kind = role === 'proveedor' ? 'proveedor' : 'cliente';
  const ex = p.nif ? db.prepare('SELECT * FROM contacts WHERE client_id = ? AND nif = ?').get(clientId, p.nif) : db.prepare('SELECT * FROM contacts WHERE client_id = ? AND name = ? COLLATE NOCASE').get(clientId, p.name);
  if (ex) db.prepare('UPDATE contacts SET name=?, address=COALESCE(?, address), postal_city=COALESCE(?, postal_city), email=COALESCE(?, email), kind=CASE WHEN kind <> ? THEN \'ambos\' ELSE kind END WHERE id=?')
    .run(p.name, p.address, p.postal_city, p.email, kind, ex.id);
  else db.prepare('INSERT INTO contacts (client_id, kind, name, nif, address, postal_city, email) VALUES (?,?,?,?,?,?,?)').run(clientId, kind, p.name, p.nif, p.address, p.postal_city, p.email);
}

function saleOut(d) {
  const o = docOut(d, true);
  if (o.draft) { o.totals = sales.totals(o.draft); o.numero = o.seq ? sales.numberFor(o.doc_type, Number(o.series.slice(-4)), o.seq) : null; }
  o.links = linkedDocs(d.client_id, d.id);
  return o;
}
const linkDocs = (clientId, a, b) => db.prepare('INSERT OR IGNORE INTO doc_links (client_id, from_id, to_id, auto) VALUES (?, ?, ?, 0)').run(clientId, Math.min(a, b), Math.max(a, b));
const createdDoc = req => { const d = getDoc(req); if (d.source !== 'creado') throw bad('Este documento no se creó en Gesty'); return d; };

c.get('/sales/meta', (req, res) => res.json({ types: sales.TYPES, states: sales.STATES, company: companyOf(req.client) }));
c.post('/sales', async (req, res) => {
  const b = req.body || {};
  res.status(201).json(saleOut(await saveCreated(req, b.type, b.draft || {}, { emit: !!b.emit })));
});
c.get('/sales/:id', (req, res) => res.json(saleOut(createdDoc(req))));
c.put('/sales/:id', async (req, res) => {
  const d = createdDoc(req);
  res.json(saleOut(await saveCreated(req, req.body?.type && d.doc_state === 'borrador' ? req.body.type : d.doc_type, req.body?.draft || {}, { id: d.id, emit: !!req.body?.emit })));
});
c.post('/sales/:id/state', (req, res) => {
  const d = createdDoc(req);
  const st = String(req.body?.state || '');
  if (!sales.STATES[d.doc_type]?.includes(st) || d.doc_state === 'borrador') return res.status(400).json({ error: 'Estado no válido' });
  db.prepare('UPDATE documents SET doc_state = ? WHERE id = ?').run(st, d.id);
  audit(req, `Estado cambiado a "${st}"`, 'documento', d.id);
  res.json(saleOut(getDoc(req)));
});
// Convertir: presupuesto → pedido → albarán → factura (copia cliente y líneas y enlaza los documentos)
c.post('/sales/:id/convert', async (req, res) => {
  const src = createdDoc(req);
  const to = String(req.body?.to || '');
  if (!['pedido', 'albaran', 'factura'].includes(to)) return res.status(400).json({ error: 'Conversión no válida' });
  const d = JSON.parse(src.draft_json);
  const srcNum = src.seq ? sales.numberFor(src.doc_type, Number(src.series.slice(-4)), src.seq) : null;
  const draft = { ...d, fecha: new Date().toISOString().slice(0, 10), vencimiento: null, ref: srcNum ? `${sales.TYPES[src.doc_type].label} ${srcNum}` : d.ref, validez: null, rect: null };
  const nd = await saveCreated(req, to, draft);
  linkDocs(req.client.id, src.id, nd.id);
  const mark = { presupuesto: 'aceptado', albaran: to === 'factura' ? 'facturado' : null, pedido: to === 'albaran' || to === 'factura' ? 'servido' : null }[src.doc_type];
  if (mark && src.doc_state !== 'borrador') db.prepare('UPDATE documents SET doc_state = ? WHERE id = ?').run(mark, src.id);
  audit(req, `Convertido en ${sales.TYPES[to].label.toLowerCase()}`, 'documento', src.id);
  res.status(201).json(saleOut(nd));
});
// Una factura con varios albaranes del mismo cliente
c.post('/sales/invoice-from', async (req, res) => {
  const ids = (req.body?.ids || []).map(Number);
  const docs = ids.map(id => db.prepare("SELECT * FROM documents WHERE id = ? AND client_id = ? AND source = 'creado' AND doc_type = 'albaran'").get(id, req.client.id)).filter(Boolean);
  if (!docs.length) return res.status(400).json({ error: 'Selecciona albaranes creados en Gesty' });
  const drafts = docs.map(x => JSON.parse(x.draft_json));
  const party = drafts[0].party;
  if (drafts.some(x => (x.party.nif || x.party.name) !== (party.nif || party.name))) return res.status(400).json({ error: 'Los albaranes deben ser del mismo cliente' });
  const lines = docs.flatMap((x, i) => [{ desc: `Albarán ${sales.numberFor('albaran', Number(x.series?.slice(-4) || 0), x.seq || 0)} de ${sales.isoToEs(drafts[i].fecha)}`, qty: 0, price: 0, iva: drafts[i].lines[0]?.iva ?? 21 }, ...drafts[i].lines]);
  const nd = await saveCreated(req, 'factura', { ...drafts[0], lines, fecha: new Date().toISOString().slice(0, 10), vencimiento: null, ref: null });
  for (const x of docs) { linkDocs(req.client.id, x.id, nd.id); if (x.doc_state !== 'borrador') db.prepare("UPDATE documents SET doc_state = 'facturado' WHERE id = ?").run(x.id); }
  res.status(201).json(saleOut(nd));
});
// Factura rectificativa por diferencias: copia las líneas en negativo
c.post('/sales/:id/rectify', async (req, res) => {
  const src = createdDoc(req);
  if (src.doc_type !== 'factura' || src.doc_state === 'borrador') return res.status(400).json({ error: 'Solo se rectifican facturas emitidas' });
  const d = JSON.parse(src.draft_json);
  const numero = sales.numberFor('factura', Number(src.series.slice(-4)), src.seq);
  const nd = await saveCreated(req, 'rectificativa', { ...d, fecha: new Date().toISOString().slice(0, 10), vencimiento: null, ref: null,
    lines: d.lines.map(l => ({ ...l, qty: -l.qty })), rect: { numero, fecha: d.fecha, motivo: String(req.body?.motivo || 'Anulación de la factura') } });
  linkDocs(req.client.id, src.id, nd.id);
  res.status(201).json(saleOut(nd));
});
c.post('/sales/:id/duplicate', async (req, res) => {
  const src = createdDoc(req);
  const d = JSON.parse(src.draft_json);
  res.status(201).json(saleOut(await saveCreated(req, src.doc_type === 'rectificativa' ? 'factura' : src.doc_type, { ...d, fecha: new Date().toISOString().slice(0, 10), vencimiento: null, rect: null })));
});
// Comprueba la cadena de huellas de las facturas emitidas
c.get('/sales-chain', (req, res) => {
  const rows = db.prepare("SELECT id, doc_type, series, seq, draft_json, hash, prev_hash FROM documents WHERE client_id = ? AND hash IS NOT NULL ORDER BY issued_at, id").all(req.client.id);
  let prev = null; const broken = [];
  for (const r of rows) {
    const d = JSON.parse(r.draft_json), t = sales.totals(d), numero = sales.numberFor(r.doc_type, Number(r.series.slice(-4)), r.seq);
    if (r.prev_hash !== prev || sales.chainHash(prev, req.client, numero, d.fecha, t.total) !== r.hash) broken.push(numero);
    prev = r.hash;
  }
  res.json({ invoices: rows.length, ok: !broken.length, broken });
});

// Agenda de clientes y proveedores
const contactBody = b => ({ kind: ['cliente', 'proveedor', 'ambos'].includes(b.kind) ? b.kind : 'cliente', name: clean(b.name), nif: clean(b.nif)?.toUpperCase().replace(/[\s.\-]/g, '') || null,
  address: clean(b.address), postal_city: clean(b.postal_city), email: clean(b.email), phone: clean(b.phone), notes: clean(b.notes) });
c.get('/contacts', (req, res) => {
  const rows = db.prepare('SELECT * FROM contacts WHERE client_id = ? ORDER BY name COLLATE NOCASE').all(req.client.id);
  // Volumen de operaciones con cada tercero (facturas)
  const ents = accountingEntries(req.client, false).filter(e => e.source === 'doc');
  const owner = new Map(db.prepare('SELECT id, contact_id FROM documents WHERE client_id = ? AND contact_id IS NOT NULL').all(req.client.id).map(d => [d.id, d.contact_id]));
  res.json(rows.map(c => {
    const mine = ents.filter(e => owner.has(e.id) ? owner.get(e.id) === c.id : (c.nif && e.nif === c.nif) || (!c.nif && e.tercero && e.tercero.toLowerCase() === c.name.toLowerCase()));
    return { ...c, ventas: Math.round(mine.filter(e => e.kind === 'ingreso').reduce((a, e) => a + (e.base || 0), 0) * 100) / 100,
      compras: Math.round(mine.filter(e => e.kind === 'gasto').reduce((a, e) => a + (e.base || 0), 0) * 100) / 100,
      pendiente: Math.round(mine.filter(e => !e.paid && e.total > 0).reduce((a, e) => a + e.total, 0) * 100) / 100 };
  }));
});
c.post('/contacts', (req, res) => {
  const b = contactBody(req.body || {});
  if (!b.name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const r = db.prepare('INSERT INTO contacts (client_id, kind, name, nif, address, postal_city, email, phone, notes) VALUES (?,?,?,?,?,?,?,?,?)').run(req.client.id, b.kind, b.name, b.nif, b.address, b.postal_city, b.email, b.phone, b.notes);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
c.patch('/contacts/:id', (req, res) => {
  const b = contactBody(req.body || {});
  if (!b.name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  db.prepare('UPDATE contacts SET kind=?, name=?, nif=?, address=?, postal_city=?, email=?, phone=?, notes=? WHERE id=? AND client_id=?').run(b.kind, b.name, b.nif, b.address, b.postal_city, b.email, b.phone, b.notes, Number(req.params.id), req.client.id);
  res.json({ ok: true });
});
c.delete('/contacts/:id', (req, res) => { db.prepare('DELETE FROM contacts WHERE id = ? AND client_id = ?').run(Number(req.params.id), req.client.id); res.json({ ok: true }); });
// Crea la agenda a partir de los terceros de los documentos subidos
c.post('/contacts/import', (req, res) => {
  let n = 0;
  for (const d of db.prepare("SELECT direction, extracted_json, corrected_json FROM documents WHERE client_id = ?").all(req.client.id)) {
    const f = (JSON.parse(d.corrected_json || 'null') || JSON.parse(d.extracted_json || '{}')).fields || {};
    if (!f.proveedor) continue;
    const before = db.prepare('SELECT COUNT(*) n FROM contacts WHERE client_id = ?').get(req.client.id).n;
    upsertContact(req.client.id, { name: f.proveedor, nif: f.nif ? String(f.nif).toUpperCase() : null }, d.direction === 'emitido' ? 'cliente' : 'proveedor');
    n += db.prepare('SELECT COUNT(*) n FROM contacts WHERE client_id = ?').get(req.client.id).n - before;
  }
  res.json({ added: n });
});

// Catálogo de artículos y servicios
const productBody = b => ({ name: clean(b.name), ref: clean(b.ref), price: Number(String(b.price ?? 0).replace(',', '.')) || 0, iva: [0, 4, 5, 10, 21].includes(Number(b.iva)) ? Number(b.iva) : 21, unit: clean(b.unit) });
c.get('/products', (req, res) => res.json(db.prepare('SELECT * FROM products WHERE client_id = ? ORDER BY name COLLATE NOCASE').all(req.client.id)));
c.post('/products', (req, res) => {
  const b = productBody(req.body || {});
  if (!b.name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const r = db.prepare('INSERT INTO products (client_id, name, ref, price, iva, unit) VALUES (?,?,?,?,?,?)').run(req.client.id, b.name, b.ref, b.price, b.iva, b.unit);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});
c.patch('/products/:id', (req, res) => {
  const b = productBody(req.body || {});
  db.prepare('UPDATE products SET name=?, ref=?, price=?, iva=?, unit=? WHERE id=? AND client_id=?').run(b.name, b.ref, b.price, b.iva, b.unit, Number(req.params.id), req.client.id);
  res.json({ ok: true });
});
c.delete('/products/:id', (req, res) => { db.prepare('DELETE FROM products WHERE id = ? AND client_id = ?').run(Number(req.params.id), req.client.id); res.json({ ok: true }); });

// ---------------------------------------------------------------- contabilidad general (partida doble)
const ledger = require('./ledger');
function booksFor(req) {
  const year = Number(req.query.year) || new Date().getFullYear();
  const openings = db.prepare('SELECT year, account, amount FROM opening_balances WHERE client_id = ?').all(req.client.id);
  const entries = accountingEntries(req.client, req.query.validated === '1');
  const r = ledger.books(entries, filingsOf(req.client.id), openings, fiscal.profileOf(req.client), year);
  return { ...r, years: [...new Set(yearsOf(entries).concat(new Date().getFullYear()))].sort((a, b) => b - a), openings: openings.filter(o => o.year === year) };
}
c.get('/ledger', (req, res) => res.json(booksFor(req)));
c.get('/ledger.csv', (req, res) => {
  const b = booksFor(req);
  const dec = v => (v ? String(v).replace('.', ',') : '');
  const t = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let rows, name;
  if (req.query.book === 'mayor') {
    name = `libro-mayor-${b.year}.csv`;
    rows = [['Cuenta', 'Nombre', 'Asiento', 'Fecha', 'Concepto', 'Debe', 'Haber', 'Saldo'].join(';'),
      ...b.ledger.flatMap(m => m.moves.map(mv => [m.account, t(m.name), mv.n, mv.date.split('-').reverse().join('/'), t(mv.concepto), dec(mv.d), dec(mv.h), dec(mv.saldo)].join(';')))];
  } else if (req.query.book === 'sumas') {
    name = `sumas-y-saldos-${b.year}.csv`;
    rows = [['Cuenta', 'Nombre', 'Debe', 'Haber', 'Saldo deudor', 'Saldo acreedor'].join(';'), ...b.trial.map(m => [m.account, t(m.name), dec(m.d), dec(m.h), dec(m.deudor), dec(m.acreedor)].join(';'))];
  } else {
    name = `libro-diario-${b.year}.csv`;
    rows = [['Asiento', 'Fecha', 'Concepto', 'Cuenta', 'Nombre', 'Debe', 'Haber'].join(';'),
      ...b.journal.flatMap(e => e.lines.map(l => [e.n, e.date.split('-').reverse().join('/'), t(e.concepto), l.a, t(l.name), dec(l.d), dec(l.h)].join(';')))];
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send('\ufeff' + rows.join('\r\n'));
});
// Saldos iniciales (al empezar a usar Gesty): banco, capital, deudas…
c.put('/ledger/opening', (req, res) => {
  const year = Number(req.body?.year);
  if (!year) return res.status(400).json({ error: 'Año no válido' });
  const items = (req.body?.items || []).filter(i => ledger.ACCOUNTS[i.account] && Number.isFinite(Number(i.amount)));
  db.prepare('DELETE FROM opening_balances WHERE client_id = ? AND year = ?').run(req.client.id, year);
  const ins = db.prepare('INSERT INTO opening_balances (client_id, year, account, amount) VALUES (?, ?, ?, ?)');
  for (const i of items) if (Number(i.amount)) ins.run(req.client.id, year, String(i.account), Math.round(Number(i.amount) * 100) / 100);
  audit(req, 'Saldos iniciales actualizados', 'empresa', req.client.id, `${year}: ${items.map(i => `${i.account} ${i.amount}`).join(', ')}`);
  res.json({ ok: true });
});

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
