'use strict';
// Datos iniciales para el entorno local. Se puede ejecutar varias veces: no duplica nada.
//   ADMIN_PASSWORD=... CLIENT_PASSWORD=... npm run seed   (si no se indican, se generan)
const crypto = require('node:crypto');
const { db, hashPassword } = require('./db');

const genPassword = () => crypto.randomBytes(9).toString('base64url');
const created = [];

function ensureUser({ email, name, role, clientId, password }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return { id: existing.id, created: false };
  const pwd = password || genPassword();
  const r = db.prepare('INSERT INTO users (email, password_hash, name, role, client_id) VALUES (?, ?, ?, ?, ?)')
    .run(email, hashPassword(pwd), name, role, clientId ?? null);
  created.push({ role, email, password: pwd });
  return { id: Number(r.lastInsertRowid), created: true };
}

// 1. Administrador
ensureUser({ email: 'admin@gesty.local', name: 'Administrador Gesty', role: 'admin', password: process.env.ADMIN_PASSWORD });

// 2. Cliente Torca 3D con su usuario de acceso
let client = db.prepare('SELECT * FROM clients WHERE name = ?').get('Torca 3D');
if (!client) {
  const r = db.prepare("INSERT INTO clients (name, email, plan) VALUES ('Torca 3D', 'torca3d@gesty.local', 'basico')").run();
  client = db.prepare('SELECT * FROM clients WHERE id = ?').get(r.lastInsertRowid);
}
ensureUser({ email: 'torca3d@gesty.local', name: 'Torca 3D', role: 'client', clientId: client.id, password: process.env.CLIENT_PASSWORD });

// 3. Local "Torca 3D"
let local = db.prepare('SELECT * FROM locales WHERE client_id = ? AND name = ?').get(client.id, 'Torca 3D');
if (!local) {
  const r = db.prepare('INSERT INTO locales (client_id, name) VALUES (?, ?)').run(client.id, 'Torca 3D');
  local = { id: Number(r.lastInsertRowid) };
}

// 4. Empleado Javier González en ese local
if (!db.prepare('SELECT 1 FROM employees WHERE client_id = ? AND name = ?').get(client.id, 'Javier González')) {
  db.prepare('INSERT INTO employees (client_id, local_id, name, position) VALUES (?, ?, ?, ?)').run(client.id, local.id, 'Javier González', 'Empleado');
}

console.log('Datos iniciales listos: admin, cliente "Torca 3D", local "Torca 3D" y empleado "Javier González".');
if (created.length) {
  console.log('\nCredenciales nuevas (guárdalas, no se vuelven a mostrar):');
  for (const u of created) console.log(`  ${u.role.padEnd(6)}  ${u.email}  /  ${u.password}`);
} else {
  console.log('Los usuarios ya existían; sus contraseñas no se han modificado.');
}
