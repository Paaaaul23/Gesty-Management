'use strict';
/*
 * Contabilidad de la empresa: ingresos, gastos, beneficio, IVA e IRPF a partir de las facturas
 * (emitidas = ingresos, recibidas = gastos; las rectificativas restan) y de los apuntes manuales
 * (nóminas, alquiler, cuotas… que no llegan como documento).
 * Importes contables = base imponible (sin IVA). El IVA va aparte: repercutido − soportado.
 */

const CATEGORIES = {
  gasto: [
    ['compras', 'Compras y materiales'],
    ['suministros', 'Luz, agua, gas y teléfono'],
    ['alquiler', 'Alquiler'],
    ['personal', 'Personal (nóminas y Seguridad Social)'],
    ['profesionales', 'Servicios profesionales'],
    ['software', 'Software, internet y hosting'],
    ['marketing', 'Publicidad y marketing'],
    ['transporte', 'Transporte y envíos'],
    ['vehiculo', 'Vehículo y combustible'],
    ['viajes', 'Viajes, comidas y dietas'],
    ['reparaciones', 'Reparaciones y mantenimiento'],
    ['seguros', 'Seguros'],
    ['bancos', 'Bancos y comisiones'],
    ['tributos', 'Impuestos y tasas'],
    ['inversion', 'Bienes de inversión (maquinaria, equipos)'],
    ['multas', 'Multas y sanciones'],
    ['otros_gastos', 'Otros gastos'],
  ],
  ingreso: [
    ['ventas', 'Ventas de productos'],
    ['servicios', 'Prestación de servicios'],
    ['otros_ingresos', 'Otros ingresos'],
  ],
};
const CATEGORY_LABEL = Object.fromEntries([...CATEGORIES.gasto, ...CATEGORIES.ingreso]);
const isCategory = (kind, c) => CATEGORIES[kind]?.some(([k]) => k === c);

// Categoría sugerida a partir del proveedor y los conceptos
const RULES = [
  ['suministros', /\b(luz|electric|energ[ií]a|kwh|potencia|agua|gas natural|butano|telef|m[oó]vil|fibra|movistar|vodafone|orange|endesa|iberdrola|naturgy|repsol luz|holaluz)\b/],
  ['alquiler', /\b(alquiler|arrendamiento|renta del local|renting)\b/],
  ['personal', /\b(n[oó]mina|seguridad social|tc1|tc2|finiquito)\b/],
  ['profesionales', /\b(asesor[ií]a|gestor[ií]a|abogad|notar|consultor|auditor|honorarios|modelo 303|modelo 111|contable)\b/],
  ['software', /\b(software|licencia|suscripci[oó]n|hosting|dominio|servidor|vps|cloud|saas|google workspace|microsoft 365|adobe)\b/],
  ['marketing', /\b(publicidad|campa[ñn]a|marketing|anuncio|flyer|tarjetas de visita|dise[ñn]o gr[aá]fico|redes sociales|google ads|meta ads)\b/],
  ['multas', /\b(multa|sanci[oó]n|recargo de apremio|dgt)\b/],
  ['vehiculo', /\b(combustible|gasolina|di[eé]sel|gasoil|carburante|peaje|parking|aparcamiento|taller|neum[aá]tico|itv|leasing)\b/],
  ['viajes', /\b(restaurante|men[uú] del d[ií]a|comida|cena|hotel|alojamiento|billete|vuelo|renfe|tren|taxi|dieta)\b/],
  ['transporte', /\b(transporte|mensajer[ií]a|env[ií]o|portes|paqueter[ií]a|seur|mrw|correos|gls|dhl)\b/],
  ['inversion', /\b(impresora 3d|maquinaria|m[aá]quina|ordenador|port[aá]til|equipo inform[aá]tico|mobiliario|instalaci[oó]n industrial)\b/],
  ['reparaciones', /\b(reparaci[oó]n|mantenimiento|aver[ií]a|revisi[oó]n t[eé]cnica|recambio)\b/],
  ['seguros', /\b(seguro|p[oó]liza|mapfre|allianz|axa|mutua)\b/],
  ['bancos', /\b(comisi[oó]n|banco|bancaria|intereses|tpv)\b/],
  ['tributos', /\b(impuesto|tasa|iae|ibi|ayuntamiento|agencia tributaria)\b/],
];
function suggestCategory(direction, { proveedor, lines, docType } = {}) {
  if (direction === 'emitido') {
    const text = (lines || []).map(l => l.descripcion).join(' ').toLowerCase();
    return /\b(servicio|dise[ñn]o|modelado|horas?|asesor|mantenimiento|instalaci[oó]n|formaci[oó]n|consultor)/.test(text) ? 'servicios' : 'ventas';
  }
  const text = [proveedor, ...(lines || []).map(l => l.descripcion)].join(' ').normalize('NFC').toLowerCase();
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  return docType === 'factura' || docType === 'rectificativa' ? 'compras' : 'otros_gastos';
}

// "15/03/2024" -> "2024-03-15"
const toIso = d => {
  const m = String(d || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const num = v => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));

// Documento guardado -> apunte contable (o null si no cuenta: albaranes, pedidos, presupuestos)
function docToEntry(d, { ownNif } = {}) {
  const ex = d.extracted || {}, co = d.corrected || null;
  const src = co || ex;
  const f = src.fields || {};
  const type = co?.doc_type || d.doc_type || ex.doc_type;
  if (type !== 'factura' && type !== 'rectificativa') return null;
  const direction = d.direction || ex.direction || 'recibido';
  const kind = direction === 'emitido' ? 'ingreso' : 'gasto';
  let base = num(f.base), iva = num(f.iva) ?? 0, total = num(f.total);
  const recargo = num(f.recargo) ?? 0, retencion = num(f.retencion) ?? 0;
  if (base === null && total !== null) base = r2(total - iva - recargo + retencion);
  if (total === null && base !== null) total = r2(base + iva + recargo - retencion);
  const sign = type === 'rectificativa' ? -1 : 1;
  const fecha = toIso(f.fecha);
  return {
    source: 'doc', id: d.id, kind, doc_type: type,
    date: fecha || String(d.created_at || '').slice(0, 10), dateMissing: !fecha,
    due: toIso(f.vencimiento),
    tercero: f.proveedor || null, nif: f.nif || null, numero: f.numero || null,
    concepto: type === 'rectificativa' ? 'Factura rectificativa' : (kind === 'ingreso' ? 'Factura emitida' : 'Factura recibida'),
    category: d.category || suggestCategory(direction, { proveedor: f.proveedor, lines: ex.lines, docType: type }),
    base: base === null ? null : sign * Math.abs(base), iva: sign * Math.abs(iva), recargo: sign * Math.abs(recargo), retencion: sign * Math.abs(retencion),
    total: total === null ? null : sign * Math.abs(total),
    paid: !!d.paid, paidAt: d.paid_at ? String(d.paid_at).slice(0, 10) : null, validated: d.status === 'validado', incomplete: base === null,
    filename: d.filename,
    ivaRate: num(f.iva_tipo),
    // Datos para la deducibilidad del IVA: ticket/factura simplificada y si figura el NIF propio
    simplificada: /factura\s+simplificada|\bticket\b|\bf\.?\s?simplificada/i.test(d.raw_text || ''),
    recipientOk: ownNif ? String(d.raw_text || '').toUpperCase().replace(/[\s.\-]/g, '').includes(ownNif) : null,
  };
}

function manualToEntry(e) {
  return {
    source: 'manual', id: e.id, kind: e.kind, doc_type: null,
    date: e.fecha, dateMissing: false, due: null,
    tercero: e.tercero, nif: null, numero: null, concepto: e.concepto,
    category: e.category, base: num(e.base) ?? 0, iva: num(e.iva) ?? 0, recargo: 0, retencion: num(e.retencion) ?? 0,
    total: num(e.total) ?? r2((num(e.base) ?? 0) + (num(e.iva) ?? 0) - (num(e.retencion) ?? 0)),
    paid: !!e.paid, validated: true, incomplete: false,
  };
}

function inPeriod(date, { year, quarter, month }) {
  if (!date) return false;
  const [y, m] = date.split('-').map(Number);
  if (y !== year) return false;
  if (month) return m === month;
  if (quarter) return Math.ceil(m / 3) === quarter;
  return true;
}

// Cálculo principal
function compute(entriesAll, period, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const inYear = entriesAll.filter(e => inPeriod(e.date, { year: period.year }));
  const entries = inYear.filter(e => inPeriod(e.date, period));
  const usable = entries.filter(e => !e.incomplete);
  const sum = (arr, k) => r2(arr.reduce((a, e) => a + (e[k] || 0), 0));
  const ing = usable.filter(e => e.kind === 'ingreso'), gas = usable.filter(e => e.kind === 'gasto');
  // El recargo de equivalencia soportado no es deducible: cuenta como gasto
  const ingresos = sum(ing, 'base');
  const gastos = r2(sum(gas, 'base') + sum(gas, 'recargo'));
  const beneficio = r2(ingresos - gastos);

  const months = Array.from({ length: 12 }, (_, i) => {
    const m = inYear.filter(e => !e.incomplete && Number(e.date.slice(5, 7)) === i + 1);
    const inn = sum(m.filter(e => e.kind === 'ingreso'), 'base');
    const g = r2(sum(m.filter(e => e.kind === 'gasto'), 'base') + sum(m.filter(e => e.kind === 'gasto'), 'recargo'));
    return { month: i + 1, ingresos: inn, gastos: g, beneficio: r2(inn - g) };
  });

  const quarters = [1, 2, 3, 4].map(q => {
    const qe = inYear.filter(e => !e.incomplete && Math.ceil(Number(e.date.slice(5, 7)) / 3) === q);
    const rep = sum(qe.filter(e => e.kind === 'ingreso'), 'iva');
    // Solo el IVA de facturas recibidas (con documento) o de apuntes con IVA es deducible
    const sop = sum(qe.filter(e => e.kind === 'gasto'), 'iva');
    return {
      quarter: q, repercutido: rep, soportado: sop, resultado: r2(rep - sop),
      retencionesPracticadas: sum(qe.filter(e => e.kind === 'gasto'), 'retencion'),   // modelo 111: las ingresa la empresa
      retencionesSoportadas: sum(qe.filter(e => e.kind === 'ingreso'), 'retencion'),  // a cuenta del IRPF/IS de la empresa
    };
  });

  const byCategory = kind => {
    const map = {};
    for (const e of usable.filter(x => x.kind === kind)) {
      const k = e.category || (kind === 'gasto' ? 'otros_gastos' : 'otros_ingresos');
      map[k] = r2((map[k] || 0) + e.base + (kind === 'gasto' ? e.recargo : 0));
    }
    return Object.entries(map).map(([key, amount]) => ({ key, label: CATEGORY_LABEL[key] || key, amount })).sort((a, b) => b.amount - a.amount);
  };
  const topTerceros = kind => {
    const map = {};
    for (const e of usable.filter(x => x.kind === kind && x.tercero)) {
      const k = e.tercero.trim();
      map[k] = map[k] || { name: k, amount: 0, count: 0 };
      map[k].amount = r2(map[k].amount + e.base);
      map[k].count++;
    }
    return Object.values(map).sort((a, b) => b.amount - a.amount).slice(0, 6);
  };

  // Pendientes de cobro y pago: facturas sin marcar como pagadas (de cualquier fecha)
  const pending = kind => entriesAll
    .filter(e => e.source === 'doc' && e.kind === kind && !e.paid && e.total && e.total > 0)
    .map(e => ({ id: e.id, tercero: e.tercero, numero: e.numero, date: e.date, due: e.due, total: e.total, overdue: !!(e.due && e.due < today) }))
    .sort((a, b) => (a.due || a.date).localeCompare(b.due || b.date));
  const porCobrar = pending('ingreso'), porPagar = pending('gasto');

  const q = period.quarter ? quarters[period.quarter - 1] : null;
  const ivaPeriodo = q ? q : { repercutido: sum(ing, 'iva'), soportado: sum(gas, 'iva'), resultado: r2(sum(ing, 'iva') - sum(gas, 'iva')) };

  return {
    period,
    totals: { ingresos, gastos, beneficio, margen: ingresos ? r2(beneficio / ingresos * 100) : null },
    iva: { repercutido: ivaPeriodo.repercutido, soportado: ivaPeriodo.soportado, resultado: ivaPeriodo.resultado },
    retenciones: { practicadas: sum(gas, 'retencion'), soportadas: sum(ing, 'retencion') },
    months, quarters,
    categories: { gasto: byCategory('gasto'), ingreso: byCategory('ingreso') },
    top: { clientes: topTerceros('ingreso'), proveedores: topTerceros('gasto') },
    pending: {
      porCobrar: { total: r2(porCobrar.reduce((a, e) => a + e.total, 0)), vencido: r2(porCobrar.filter(e => e.overdue).reduce((a, e) => a + e.total, 0)), items: porCobrar.slice(0, 50) },
      porPagar: { total: r2(porPagar.reduce((a, e) => a + e.total, 0)), vencido: r2(porPagar.filter(e => e.overdue).reduce((a, e) => a + e.total, 0)), items: porPagar.slice(0, 50) },
    },
    counts: {
      apuntes: entries.length,
      sinValidar: entries.filter(e => e.source === 'doc' && !e.validated).length,
      incompletos: entries.filter(e => e.incomplete).length,
      sinFecha: entries.filter(e => e.dateMissing).length,
    },
    entries: entries.sort((a, b) => b.date.localeCompare(a.date)),
  };
}

// Libro de ingresos y gastos en CSV (separador ";" y coma decimal, como lo abre Excel en España)
function toCsv(entries) {
  const dec = v => (v === null || v === undefined ? '' : String(r2(v)).replace('.', ','));
  const txt = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Fecha', 'Tipo', 'Documento', 'Número', 'Tercero', 'NIF', 'Concepto', 'Categoría', 'Base imponible', 'IVA', 'Recargo', 'Retención', 'Total', 'Estado'];
  const rows = entries.map(e => [
    e.date.split('-').reverse().join('/'), e.kind === 'ingreso' ? 'Ingreso' : 'Gasto', e.source === 'doc' ? (e.doc_type === 'rectificativa' ? 'Rectificativa' : 'Factura') : 'Apunte manual',
    txt(e.numero), txt(e.tercero), txt(e.nif), txt(e.concepto), txt(CATEGORY_LABEL[e.category] || e.category), dec(e.base), dec(e.iva), dec(e.recargo), dec(e.retencion), dec(e.total),
    e.kind === 'ingreso' ? (e.paid ? 'Cobrado' : 'Pendiente de cobro') : (e.paid ? 'Pagado' : 'Pendiente de pago'),
  ].join(';'));
  return '﻿' + [head.join(';'), ...rows].join('\r\n');
}

module.exports = { CATEGORIES, CATEGORY_LABEL, isCategory, suggestCategory, docToEntry, manualToEntry, compute, toCsv, toIso };
