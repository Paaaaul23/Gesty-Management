'use strict';
// Comprobaciones antes de arrancar (las usa "Iniciar Gesty.bat").
// Código de salida: 0 todo bien · 1 hay que instalar o actualizar dependencias · 3 Node.js demasiado antiguo
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.log(`\n  Tienes Node.js ${process.versions.node} y Gesty necesita la versión 22.13 o superior.`);
  console.log('  Descarga la versión LTS desde https://nodejs.org, instálala y vuelve a abrir Gesty.\n');
  process.exit(3);
}

// Cada paquete del package-lock que corresponde a este sistema debe estar instalado y en su versión
let lock;
try { lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')); }
catch { process.exit(1); }
const missing = [];
for (const [key, info] of Object.entries(lock.packages || {})) {
  if (!key || info.dev || info.optional || info.devOptional) continue;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, key, 'package.json'), 'utf8'));
    if (info.version && pkg.version !== info.version) missing.push(key);
  } catch { missing.push(key); }
}
if (missing.length) {
  console.log(`  Faltan o están desactualizadas ${missing.length} dependencias (p. ej. ${missing[0].replace(/^node_modules\//, '')}).`);
  process.exit(1);
}
process.exit(0);
