'use strict';
/*
 * Contabilidad por partida doble según el Plan General de Contabilidad de PYMES.
 * Los asientos se GENERAN a partir de los datos de Gesty (facturas, cobros y pagos, apuntes
 * manuales, modelos presentados, amortizaciones y saldos iniciales), así que siempre cuadran
 * con el resto de la aplicación. De ahí salen el libro diario, el mayor, el balance de sumas y
 * saldos, la cuenta de pérdidas y ganancias y el balance de situación.
 */
const { deductibility } = require('./fiscal');

const ACCOUNTS = {
  100: 'Capital social', 120: 'Remanente', 121: 'Resultados negativos de ejercicios anteriores', 129: 'Resultado del ejercicio',
  213: 'Maquinaria', 2813: 'Amortización acumulada de maquinaria',
  400: 'Proveedores', 410: 'Acreedores por prestaciones de servicios', 430: 'Clientes', 465: 'Remuneraciones pendientes de pago',
  4700: 'Hacienda Pública, deudora por IVA', 472: 'Hacienda Pública, IVA soportado', 473: 'Hacienda Pública, retenciones y pagos a cuenta',
  4750: 'Hacienda Pública, acreedora por IVA', 4751: 'Hacienda Pública, acreedora por retenciones practicadas', 477: 'Hacienda Pública, IVA repercutido',
  572: 'Bancos e instituciones de crédito c/c',
  600: 'Compras de mercaderías', 621: 'Arrendamientos y cánones', 622: 'Reparaciones y conservación', 623: 'Servicios de profesionales independientes',
  624: 'Transportes', 625: 'Primas de seguros', 626: 'Servicios bancarios y similares', 627: 'Publicidad, propaganda y relaciones públicas', 628: 'Suministros',
  629: 'Otros servicios', 631: 'Otros tributos', 640: 'Sueldos y salarios', 678: 'Gastos excepcionales', 681: 'Amortización del inmovilizado material',
  700: 'Ventas de mercaderías', 705: 'Prestaciones de servicios', 759: 'Ingresos por servicios diversos',
};
const CATEGORY_ACCOUNT = {
  compras: 600, suministros: 628, alquiler: 621, personal: 640, profesionales: 623, software: 629, marketing: 627, transporte: 624, vehiculo: 628,
  viajes: 629, reparaciones: 622, seguros: 625, bancos: 626, tributos: 631, inversion: 213, multas: 678, otros_gastos: 629,
  ventas: 700, servicios: 705, otros_ingresos: 759,
};
const AMORT_RATE = 0.12;   // maquinaria: coeficiente lineal máximo de la tabla (12 %)

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const nameOf = a => ACCOUNTS[a] || `Cuenta ${a}`;
const group = a => String(a)[0];
const isPL = a => ['6', '7'].includes(group(a));

// Asiento: líneas { a: cuenta, d: debe, h: haber }. Los importes negativos (rectificativas) cambian de lado.
function entry(date, concepto, lines, ref = null) {
  const out = [];
  for (const l of lines) {
    let d = r2(l.d || 0), h = r2(l.h || 0);
    if (d < 0) { h = r2(h - d); d = 0; }
    if (h < 0) { d = r2(d - h); h = 0; }
    if (d || h) out.push({ a: String(l.a), d, h });
  }
  return out.length ? { date, concepto, lines: out, ref } : null;
}

function movements(entries, filings, profile, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const A = [];
  const push = e => e && A.push(e);
  const quarterIva = {};   // "2025-1" -> { rep, sop }
  const qk = date => `${date.slice(0, 4)}-${Math.ceil(Number(date.slice(5, 7)) / 3)}`;

  for (const e of entries) {
    if (e.incomplete) continue;
    const base = e.base || 0, iva = e.iva || 0, rec = e.recargo || 0, ret = e.retencion || 0, total = e.total ?? r2(base + iva + rec - ret);
    const cat = CATEGORY_ACCOUNT[e.category] || (e.kind === 'ingreso' ? 759 : 629);
    const who = e.tercero || e.concepto || '';
    const ref = e.source === 'doc' ? { doc: e.id } : { entry: e.id };
    if (e.kind === 'gasto') {
      const personal = e.source === 'manual' && e.category === 'personal';
      const ded = deductibility(e, profile);
      const ivaDed = ded ? ded.ivaDeducible : iva;
      const payable = personal ? 465 : e.category === 'compras' ? 400 : 410;
      push(entry(e.date, `${e.source === 'doc' ? (e.doc_type === 'rectificativa' ? 'Rectificativa recibida' : 'Factura recibida') + ' ' + (e.numero || '') : e.concepto} · ${who}`, [
        { a: cat, d: r2(base + (iva - ivaDed) + rec) }, { a: 472, d: ivaDed }, { a: 4751, h: ret }, { a: payable, h: total },
      ], ref));
      (quarterIva[qk(e.date)] ||= { rep: 0, sop: 0 }).sop += ivaDed;
      if (e.paid) push(entry(e.paidAt || e.date, `Pago ${e.numero || e.concepto || ''} · ${who}`, [{ a: payable, d: total }, { a: 572, h: total }], ref));
    } else {
      push(entry(e.date, `${e.source === 'doc' ? (e.doc_type === 'rectificativa' ? 'Rectificativa emitida' : 'Factura emitida') + ' ' + (e.numero || '') : e.concepto} · ${who}`, [
        { a: 430, d: total }, { a: 473, d: ret }, { a: cat, h: base }, { a: 477, h: r2(iva + rec) },
      ], ref));
      (quarterIva[qk(e.date)] ||= { rep: 0, sop: 0 }).rep += iva + rec;
      if (e.paid) push(entry(e.paidAt || e.date, `Cobro ${e.numero || e.concepto || ''} · ${who}`, [{ a: 572, d: total }, { a: 430, h: total }], ref));
    }
    // Amortización lineal de los bienes de inversión (a 31/12 de cada año, o hasta hoy en el año en curso)
    if (e.kind === 'gasto' && e.category === 'inversion' && base > 0) {
      let acc = 0;
      const start = new Date(e.date + 'T12:00:00Z');
      for (let y = start.getUTCFullYear(); acc < base - 0.005; y++) {
        const end = `${y}-12-31` < today ? `${y}-12-31` : today;
        if (end < e.date) break;
        const from = y === start.getUTCFullYear() ? start : new Date(`${y}-01-01T12:00:00Z`);
        const days = (new Date(end + 'T12:00:00Z') - from) / 86400000 + 1;
        const amount = Math.min(r2(base * AMORT_RATE * days / 365), r2(base - acc));
        if (amount > 0) push(entry(end, `Amortización ${who}${end === today ? ' (hasta hoy)' : ''}`, [{ a: 681, d: amount }, { a: 2813, h: amount }], ref));
        acc = r2(acc + amount);
        if (end === today) break;
      }
    }
  }

  // Liquidación trimestral del IVA al cierre de cada trimestre terminado
  for (const [k, v] of Object.entries(quarterIva)) {
    const [y, q] = k.split('-').map(Number);
    const end = new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10);
    if (end > today) continue;
    const res = r2(v.rep - v.sop);
    push(entry(end, `Liquidación de IVA ${q}T ${y}`, [{ a: 477, d: r2(v.rep) }, { a: 472, h: r2(v.sop) }, res >= 0 ? { a: 4750, h: res } : { a: 4700, d: -res }]));
  }
  // Pagos de los modelos presentados
  const PAY = { 303: 4750, 111: 4751, 115: 4751, 130: 473, 202: 473 };
  for (const f of filings) {
    if (!PAY[f.modelo] || !(f.amount > 0)) continue;
    const date = f.presented_at || today;
    push(entry(date, `Pago modelo ${f.modelo} ${f.period} ${f.year}`, [{ a: PAY[f.modelo], d: f.amount }, { a: 572, h: f.amount }], { filing: f.id }));
  }
  return A.sort((a, b) => a.date.localeCompare(b.date));
}

// Libro diario, mayor, sumas y saldos, PyG y balance de un ejercicio
function books(entries, filings, openings, profile, year, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const all = movements(entries, filings, profile, { today });
  const firstYear = Math.min(year, ...all.map(e => Number(e.date.slice(0, 4))), ...openings.map(o => o.year));
  const bal = {};   // saldos acumulados (deudor positivo)
  const add = (a, v) => { bal[a] = r2((bal[a] || 0) + v); };
  const journal = [];
  // Saldos iniciales introducidos a mano (el primer año, o el año en que se indiquen)
  const openingEntry = y => {
    const rows = openings.filter(o => o.year === y && o.amount);
    if (!rows.length) return null;
    const lines = rows.map(o => ({ a: o.account, d: o.amount > 0 ? o.amount : 0, h: o.amount < 0 ? -o.amount : 0 }));
    const diff = r2(rows.reduce((a, o) => a + o.amount, 0));
    if (diff) lines.push({ a: 120, h: diff > 0 ? diff : 0, d: diff < 0 ? -diff : 0 });   // cuadra contra el patrimonio previo
    return entry(`${y}-01-01`, 'Saldos iniciales', lines);
  };
  for (let y = firstYear; y < year; y++) {
    const oe = openingEntry(y);
    if (oe) for (const l of oe.lines) add(l.a, l.d - l.h);
    for (const e of all.filter(x => x.date.startsWith(String(y)))) for (const l of e.lines) add(l.a, l.d - l.h);
    // Cierre del año anterior: el resultado pasa a remanente (positivo) o resultados negativos
    const res = r2(Object.entries(bal).filter(([a]) => isPL(a)).reduce((s, [, v]) => s + v, 0));   // deudor = pérdidas
    for (const a of Object.keys(bal)) if (isPL(a)) delete bal[a];
    if (res) add(res > 0 ? 121 : 120, res);
  }
  // Asiento de apertura del ejercicio con los saldos de balance acumulados + saldos iniciales del año
  const opening = Object.entries(bal).filter(([, v]) => Math.abs(v) >= 0.005).map(([a, v]) => ({ a, d: v > 0 ? v : 0, h: v < 0 ? -v : 0 }));
  const manualOpen = openingEntry(year);
  const openLines = [...opening, ...(manualOpen ? manualOpen.lines : [])];
  if (openLines.length) journal.push({ date: `${year}-01-01`, concepto: 'Asiento de apertura', lines: openLines.map(l => ({ a: String(l.a), d: r2(l.d), h: r2(l.h) })) });
  journal.push(...all.filter(e => e.date.startsWith(String(year))));
  const yearEnded = `${year}-12-31` < today;

  // Mayor y sumas y saldos
  const accs = {};
  journal.forEach((e, i) => {
    e.n = i + 1;
    for (const l of e.lines) {
      const m = accs[l.a] ||= { account: l.a, name: nameOf(l.a), d: 0, h: 0, moves: [] };
      m.d = r2(m.d + l.d); m.h = r2(m.h + l.h);
      m.moves.push({ n: e.n, date: e.date, concepto: e.concepto, d: l.d, h: l.h, ref: e.ref });
    }
  });
  const ledger = Object.values(accs).sort((a, b) => String(a.account).localeCompare(String(b.account)));
  for (const m of ledger) { let s = 0; for (const mv of m.moves) { s = r2(s + mv.d - mv.h); mv.saldo = s; } m.saldo = r2(m.d - m.h); }
  const sb = a => accs[a]?.saldo || 0;                             // saldo deudor
  const sumP = prefixes => r2(ledger.filter(m => prefixes.some(p => String(m.account).startsWith(p))).reduce((s, m) => s + m.saldo, 0));

  // Cuenta de pérdidas y ganancias (modelo abreviado PYMES)
  const cifra = -sumP(['70']), aprov = -sumP(['60']), otrosIng = -sumP(['75']), personal = -sumP(['64']), otrosGastos = -sumP(['62', '631']), amort = -sumP(['68']), otrosRes = -sumP(['678']);
  const explot = r2(cifra + aprov + otrosIng + personal + otrosGastos + amort + otrosRes);
  const pyg = [
    ['1', 'Importe neto de la cifra de negocios', cifra], ['4', 'Aprovisionamientos', aprov], ['5', 'Otros ingresos de explotación', otrosIng],
    ['6', 'Gastos de personal', personal], ['7', 'Otros gastos de explotación', otrosGastos], ['8', 'Amortización del inmovilizado', amort],
    ['13', 'Otros resultados', otrosRes], ['A.1', 'RESULTADO DE EXPLOTACIÓN', explot, true],
    ['A.3', 'RESULTADO ANTES DE IMPUESTOS', explot, true],
  ];
  let impuesto = 0;
  if (profile.forma === 'sociedad' && explot > 0) impuesto = r2(explot * (profile.is_tipo || 25) / 100);
  if (impuesto) pyg.push(['17', `Impuestos sobre beneficios (estimado, ${profile.is_tipo || 25} %)`, -impuesto]);
  const resultado = r2(explot - impuesto);
  pyg.push(['A.4', 'RESULTADO DEL EJERCICIO', resultado, true]);

  // Balance de situación: cada cuenta va al activo o al pasivo según el signo de su saldo
  const bs = ledger.filter(m => !isPL(m.account));
  const deb = f => r2(bs.filter(m => f(String(m.account)) && m.saldo > 0).reduce((s, m) => s + m.saldo, 0));
  const cre = f => r2(bs.filter(m => f(String(m.account)) && m.saldo < 0).reduce((s, m) => s - m.saldo, 0));
  const inmov = r2(bs.filter(m => group(m.account) === '2').reduce((s, m) => s + m.saldo, 0));
  const clientes = deb(a => a === '430'), otrosDeudores = deb(a => group(a) === '4' && a !== '430'), efectivo = deb(a => group(a) === '5');
  const activo = r2(inmov + clientes + otrosDeudores + efectivo);
  const capital = r2(-bs.filter(m => m.account === '100').reduce((s, m) => s + m.saldo, 0));
  const reservas = r2(-bs.filter(m => group(m.account) === '1' && m.account !== '100').reduce((s, m) => s + m.saldo, 0));
  const proveedores = cre(a => a === '400'), otrosAcreedores = cre(a => group(a) === '4' && a !== '400'), descubierto = cre(a => group(a) === '5');
  const deudaIS = impuesto;
  const pn = r2(capital + reservas + resultado);
  const pasivo = r2(proveedores + otrosAcreedores + deudaIS + descubierto);
  const balance = {
    activo: [
      ['A', 'ACTIVO NO CORRIENTE', inmov, true], ['A.II', 'Inmovilizado material (neto de amortizaciones)', inmov],
      ['B', 'ACTIVO CORRIENTE', r2(clientes + otrosDeudores + efectivo), true], ['B.III.1', 'Clientes por ventas y prestaciones de servicios', clientes],
      ['B.III.3', 'Otros deudores (Hacienda Pública y otros)', otrosDeudores], ['B.VI', 'Efectivo y otros activos líquidos', efectivo],
      ['', 'TOTAL ACTIVO', activo, true],
    ],
    pasivo: [
      ['A', 'PATRIMONIO NETO', pn, true], ['A.1.I', 'Capital', capital], ['A.1.III', 'Reservas y resultados de ejercicios anteriores', reservas], ['A.1.VII', 'Resultado del ejercicio', resultado],
      ['C', 'PASIVO CORRIENTE', pasivo, true], ['C.V.1', 'Proveedores', proveedores], ['C.V.2', 'Otros acreedores (acreedores, Hacienda, personal)', otrosAcreedores],
      ...(deudaIS ? [['C.V.3', 'Impuesto sobre beneficios a pagar (estimado)', deudaIS]] : []), ...(descubierto ? [['C.II', 'Descubierto en bancos (faltan saldos iniciales)', descubierto]] : []),
      ['', 'TOTAL PATRIMONIO NETO Y PASIVO', r2(pn + pasivo), true],
    ],
    cuadra: Math.abs(activo - r2(pn + pasivo)) < 0.02,
    tesoreriaNegativa: descubierto > 0,
  };
  const sumD = r2(journal.reduce((s, e) => s + e.lines.reduce((a, l) => a + l.d, 0), 0));
  const sumH = r2(journal.reduce((s, e) => s + e.lines.reduce((a, l) => a + l.h, 0), 0));
  journal.forEach(e => e.lines.forEach(l => { l.name = nameOf(l.a); }));
  return {
    year, yearEnded, journal, ledger: ledger.map(m => ({ ...m, moves: m.moves })), trial: ledger.map(({ moves, ...m }) => ({ ...m, deudor: m.saldo > 0 ? m.saldo : 0, acreedor: m.saldo < 0 ? -m.saldo : 0 })),
    totals: { debe: sumD, haber: sumH, cuadra: Math.abs(sumD - sumH) < 0.02 }, pyg, resultado, balance,
  };
}

module.exports = { ACCOUNTS, CATEGORY_ACCOUNT, movements, books, nameOf };
