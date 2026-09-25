'use strict';
// Mide la precisión del reconocimiento sobre test/fixtures.
//   node test/eval.js                 todos los documentos y variantes
//   node test/eval.js f03 jpg         filtra por id y/o variante (pdf | jpg | scan)
//   node test/eval.js --verbose       muestra cada fallo
// Por defecto usa el motor local. Con ANTHROPIC_API_KEY y --ia usa también el motor con IA.
const fs = require('node:fs');
const path = require('node:path');
process.env.GESTY_QUIET = '1';
const { analyze } = require('../extract');

const DIR = path.join(__dirname, 'fixtures');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const useAi = args.includes('--ia');
const filters = args.filter(a => !a.startsWith('--'));
const VARIANTS = { pdf: '.pdf', jpg: '.jpg', scan: '-scan.pdf' };

const FIELDS = ['proveedor', 'nif', 'numero', 'fecha', 'vencimiento', 'base', 'iva_tipo', 'iva', 'total', 'forma_pago', 'iban'];
const NUM = new Set(['base', 'iva_tipo', 'iva', 'total']);
const normText = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const empty = v => v === null || v === undefined || v === '';
function same(k, a, b) {
  if (NUM.has(k)) return Math.abs(Number(a) - Number(b)) < 0.011;
  // Forma de pago: basta con que la leída contenga la esperada o al revés ("Transferencia" ≈ "Transferencia bancaria")
  if (k === 'forma_pago') { const x = normText(a), y = normText(b); return x.includes(y) || y.includes(x); }
  return normText(a) === normText(b);
}

function lineScore(exp, got) {
  if (!exp.length) return null;
  let ok = 0;
  for (const e of exp) {
    const g = got.find(l => normText(l.descripcion).includes(normText(e.descripcion).slice(0, 12)));
    if (!g) continue;
    const qOk = e.cantidad === null || Math.abs((g.cantidad ?? -1) - e.cantidad) < 0.001;
    const iOk = e.importe === null || Math.abs((g.importe ?? -1) - e.importe) < 0.011;
    const pOk = e.precio === null || Math.abs((g.precio ?? -1) - e.precio) < 0.011;
    ok += (qOk + iOk + pOk) / 3;
  }
  return ok / exp.length;
}

(async () => {
  const ids = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
  const per = Object.fromEntries(['doc_type', 'direccion', ...FIELDS, 'lineas'].map(k => [k, { ok: 0, n: 0 }]));
  const perVariant = {};
  const failures = [];
  let totalMs = 0, runs = 0;
  for (const id of ids) {
    if (filters.length && !filters.some(f => id.includes(f) || VARIANTS[f])) continue;
    const exp = JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8'));
    for (const [variant, suffix] of Object.entries(VARIANTS)) {
      if (filters.some(f => VARIANTS[f]) && !filters.includes(variant)) continue;
      const file = path.join(DIR, id + suffix);
      const t0 = Date.now();
      const r = await analyze(fs.readFileSync(file), { mime: suffix.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg', filename: path.basename(file), ownName: 'Torca 3D', ai: useAi ? undefined : false });
      totalMs += Date.now() - t0; runs++;
      const pv = perVariant[variant] ||= { ok: 0, n: 0 };
      const tally = (k, good, got, want) => {
        per[k].n++; pv.n++;
        if (good) { per[k].ok++; pv.ok++; } else failures.push(`${id} [${variant}] ${k}: leído ${JSON.stringify(got)} · correcto ${JSON.stringify(want)}`);
      };
      tally('doc_type', r.doc_type === exp.doc_type, r.doc_type, exp.doc_type);
      tally('direccion', r.direction === exp.direction, r.direction, exp.direction);
      for (const k of FIELDS) {
        const want = exp.fields[k], got = r.fields[k];
        if (empty(want) && empty(got)) continue;
        tally(k, !empty(want) && !empty(got) && same(k, got, want), got, want);
      }
      const ls = lineScore(exp.lines, r.lines || []);
      if (ls !== null) { per.lineas.n++; per.lineas.ok += ls; pv.n++; pv.ok += ls; if (ls < 0.99) failures.push(`${id} [${variant}] lineas: ${(ls * 100).toFixed(0)}% · leídas ${JSON.stringify((r.lines || []).map(l => [l.descripcion, l.cantidad, l.precio, l.importe]))}`); }
    }
  }
  const pct = (a, b) => b ? (a / b * 100).toFixed(1).padStart(5) + '%' : '    —';
  let ok = 0, n = 0;
  console.log('\nCampo            Acierto   (n)');
  for (const [k, v] of Object.entries(per)) { console.log(`${k.padEnd(16)} ${pct(v.ok, v.n)}   (${v.n})`); ok += v.ok; n += v.n; }
  console.log('\nPor variante: ' + Object.entries(perVariant).map(([k, v]) => `${k} ${pct(v.ok, v.n).trim()}`).join(' · '));
  console.log(`GLOBAL ${pct(ok, n).trim()} · ${runs} documentos · ${(totalMs / runs / 1000).toFixed(1)} s de media\n`);
  if (verbose) console.log(failures.join('\n'));
  process.exit(0);
})();
