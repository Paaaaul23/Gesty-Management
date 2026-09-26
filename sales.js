'use strict';
/*
 * Documentos que emite la empresa desde Gesty: presupuestos u ofertas, pedidos (de cliente o a
 * proveedor), albaranes, facturas y facturas rectificativas.
 * Se guardan en la tabla `documents` como cualquier otro documento (source = 'creado'), con sus
 * datos editables en `draft_json`; así cuentan en la contabilidad, los impuestos y los libros.
 */
const crypto = require('node:crypto');

const TYPES = {
  presupuesto: { label: 'Presupuesto', prefix: 'P', title: 'PRESUPUESTO' },
  pedido: { label: 'Pedido', prefix: 'PED', title: 'PEDIDO' },
  albaran: { label: 'Albarán', prefix: 'A', title: 'ALBARÁN' },
  factura: { label: 'Factura', prefix: 'F', title: 'FACTURA' },
  rectificativa: { label: 'Factura rectificativa', prefix: 'R', title: 'FACTURA RECTIFICATIVA' },
};
// Estados de cada tipo (el primero es el inicial al emitir)
const STATES = {
  presupuesto: ['emitido', 'aceptado', 'rechazado'],
  pedido: ['emitido', 'servido', 'anulado'],
  albaran: ['emitido', 'entregado', 'facturado'],
  factura: ['emitido'],
  rectificativa: ['emitido'],
};
const RE_RATE = { 21: 5.2, 10: 1.4, 5: 0.62, 4: 0.5, 0: 0 };

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const isoToEs = d => (d ? d.split('-').reverse().join('/') : null);
const money = n => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }) + ' €';

// Limpia y normaliza lo que llega del formulario
function cleanDraft(b = {}, prev = {}) {
  const s = v => (v === undefined || v === null ? null : String(v).trim() || null);
  const party = { ...(prev.party || {}), ...(b.party || {}) };
  for (const k of ['name', 'nif', 'address', 'postal_city', 'email']) party[k] = s(party[k]);
  if (party.nif) party.nif = party.nif.toUpperCase().replace(/[\s.\-]/g, '').replace(/^ES(?=[A-Z0-9]{9}$)/, '');
  const lines = (Array.isArray(b.lines) ? b.lines : prev.lines || []).map(l => ({
    desc: s(l.desc) || '', qty: num(l.qty ?? 1), price: num(l.price), dto: num(l.dto), iva: [0, 4, 5, 10, 21].includes(num(l.iva)) ? num(l.iva) : 21,
  })).filter(l => l.desc || l.price || l.qty !== 1);
  const iso = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
  return {
    role: b.role === 'proveedor' || (!b.role && prev.role === 'proveedor') ? 'proveedor' : 'cliente',
    party,
    fecha: iso(b.fecha) || prev.fecha || new Date().toISOString().slice(0, 10),
    vencimiento: 'vencimiento' in b ? iso(b.vencimiento) : prev.vencimiento || null,
    lines,
    irpf: 'irpf' in b ? Math.min(50, Math.max(0, num(b.irpf))) : prev.irpf || 0,
    recargo: 'recargo' in b ? !!b.recargo : !!prev.recargo,
    forma_pago: 'forma_pago' in b ? s(b.forma_pago) : prev.forma_pago || null,
    iban: 'iban' in b ? s(b.iban) : prev.iban || null,
    notes: 'notes' in b ? s(b.notes) : prev.notes || null,
    validez: 'validez' in b ? Math.max(0, Math.round(num(b.validez))) || null : prev.validez || null,
    ref: 'ref' in b ? s(b.ref) : prev.ref || null,              // pedido del cliente, referencia…
    rect: b.rect || prev.rect || null,                          // { numero, fecha, motivo } de la factura rectificada
  };
}

function totals(d) {
  const groups = {};
  const lines = d.lines.map(l => {
    const importe = r2(l.qty * l.price * (1 - (l.dto || 0) / 100));
    const g = groups[l.iva] ||= { rate: l.iva, base: 0 };
    g.base = r2(g.base + importe);
    return { ...l, importe };
  });
  const ivas = Object.values(groups).sort((a, b) => b.rate - a.rate).map(g => ({
    ...g, cuota: r2(g.base * g.rate / 100), re: d.recargo ? r2(g.base * (RE_RATE[g.rate] || 0) / 100) : 0, reRate: d.recargo ? RE_RATE[g.rate] || 0 : 0,
  }));
  const base = r2(ivas.reduce((a, g) => a + g.base, 0));
  const iva = r2(ivas.reduce((a, g) => a + g.cuota, 0));
  const recargo = r2(ivas.reduce((a, g) => a + g.re, 0));
  const retencion = r2(base * (d.irpf || 0) / 100);
  return { lines, ivas, base, iva, recargo, retencion, total: r2(base + iva + recargo - retencion) };
}

const numberFor = (type, year, seq) => `${TYPES[type].prefix}${year}-${String(seq).padStart(4, '0')}`;

// Campos "extraídos" equivalentes a los de un documento leído, para el resto de Gesty
function toExtracted(type, d, t, numero) {
  const rates = t.ivas.filter(g => g.base).map(g => g.rate);
  return {
    doc_type: type, direction: d.role === 'proveedor' ? 'recibido' : 'emitido', engine: 'gesty', method: 'creado', score: 100, checks: [],
    fields: {
      proveedor: d.party.name, nif: d.party.nif, numero, fecha: isoToEs(d.fecha), vencimiento: isoToEs(d.vencimiento),
      base: t.base, iva_tipo: rates.length === 1 ? rates[0] : null, iva: t.iva, recargo: t.recargo || null, retencion: t.retencion || null,
      total: t.total, forma_pago: d.forma_pago, iban: d.iban,
    },
    lines: t.lines.map(l => ({ descripcion: l.desc, cantidad: l.qty, precio: l.price, importe: l.importe })),
  };
}

// Texto del documento: sirve para buscar y para enlazar documentos que se citan entre sí
function toText(type, d, t, numero, company) {
  return [company.name, company.nif ? `NIF ${company.nif}` : '', `${TYPES[type].title} ${numero || '(borrador)'}`, `Fecha: ${isoToEs(d.fecha)}`,
    d.ref ? `Referencia: ${d.ref}` : '', d.rect ? `Rectifica la factura ${d.rect.numero} de ${isoToEs(d.rect.fecha) || ''}. Motivo: ${d.rect.motivo || ''}` : '',
    `${d.role === 'proveedor' ? 'Proveedor' : 'Cliente'}: ${d.party.name || ''} ${d.party.nif || ''}`,
    ...t.lines.map(l => `${l.desc}  ${l.qty}  ${l.price}  ${l.importe}`),
    `Base imponible ${t.base}  IVA ${t.iva}  Total ${t.total}`, d.notes || ''].filter(Boolean).join('\n');
}

// Huella encadenada: cada factura incluye la huella de la anterior (detecta cambios o borrados)
function chainHash(prevHash, company, numero, fechaIso, total) {
  return crypto.createHash('sha256').update([company.nif || '', numero, isoToEs(fechaIso), Number(total).toFixed(2), prevHash || ''].join('|')).digest('hex').toUpperCase();
}

// ---------------------------------------------------------------- PDF

function renderPdf(type, d, t, { numero, company, state, hash }) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${TYPES[type].label} ${numero || 'borrador'}`, Author: company.name, Producer: 'Gesty Management' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 96, X = 48;
  const ink = '#1b1b1b', muted = '#666666', line = '#d9d9d9', accent = '#15803d';

  // Cabecera: emisor a la izquierda, título y número a la derecha
  const issuer = company; // quien emite es siempre la propia empresa
  doc.fillColor(accent).font('Helvetica-Bold').fontSize(16).text(issuer.name || '', X, 48, { width: W * 0.55 });
  doc.fillColor(muted).font('Helvetica').fontSize(9);
  [issuer.nif ? `NIF: ${issuer.nif}` : '', issuer.address, issuer.postal_city, [issuer.phone, issuer.email].filter(Boolean).join(' · ')].filter(Boolean)
    .forEach(l => doc.text(l, { width: W * 0.55 }));
  const yHead = doc.y;
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(18).text(TYPES[type].title, X + W * 0.5, 48, { width: W * 0.5, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(ink);
  const meta = [[`Número`, numero || 'BORRADOR'], ['Fecha', isoToEs(d.fecha)]];
  if (d.vencimiento) meta.push([type === 'presupuesto' ? 'Válido hasta' : 'Vencimiento', isoToEs(d.vencimiento)]);
  else if (type === 'presupuesto' && d.validez) meta.push(['Validez', `${d.validez} días`]);
  if (d.ref) meta.push(['Referencia', d.ref]);
  meta.forEach(([k, v]) => doc.text(`${k}: ${v}`, X + W * 0.5, doc.y + 2, { width: W * 0.5, align: 'right' }));
  if (!numero) { doc.fillColor('#b45309').font('Helvetica-Bold').text('Borrador sin validez', X + W * 0.5, doc.y + 2, { width: W * 0.5, align: 'right' }); doc.fillColor(ink).font('Helvetica'); }

  // Destinatario
  let y = Math.max(yHead, doc.y) + 18;
  doc.roundedRect(X, y, W * 0.55, 74, 4).strokeColor(line).stroke();
  doc.fillColor(muted).fontSize(8).text(d.role === 'proveedor' ? 'PROVEEDOR' : 'CLIENTE', X + 10, y + 8);
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text(d.party.name || '—', X + 10, y + 20, { width: W * 0.55 - 20 });
  doc.font('Helvetica').fontSize(9);
  [d.party.nif ? `NIF: ${d.party.nif}` : '', d.party.address, d.party.postal_city].filter(Boolean).forEach(l => doc.text(l, { width: W * 0.55 - 20 }));
  y += 92;

  if (d.rect) {
    doc.fillColor(ink).fontSize(9).text(`Rectifica la factura ${d.rect.numero}${d.rect.fecha ? ' de ' + isoToEs(d.rect.fecha) : ''}. Motivo: ${d.rect.motivo || '—'}`, X, y, { width: W });
    y = doc.y + 10;
  }

  // Líneas
  const cols = [
    { k: 'desc', t: 'Descripción', w: W * 0.44, a: 'left' }, { k: 'qty', t: 'Cant.', w: W * 0.09, a: 'right' }, { k: 'price', t: 'Precio', w: W * 0.13, a: 'right' },
    { k: 'dto', t: 'Dto.', w: W * 0.08, a: 'right' }, { k: 'iva', t: 'IVA', w: W * 0.08, a: 'right' }, { k: 'importe', t: 'Importe', w: W * 0.18, a: 'right' },
  ];
  const showPrices = type !== 'albaran' || t.base !== 0;
  const drawHeader = () => {
    doc.rect(X, y, W, 20).fill('#eef1f4');
    let x = X;
    doc.fillColor(muted).font('Helvetica-Bold').fontSize(8);
    for (const c of cols) { if (showPrices || ['desc', 'qty'].includes(c.k)) doc.text(c.t.toUpperCase(), x + 4, y + 6, { width: c.w - 8, align: c.a }); x += c.w; }
    y += 24; doc.font('Helvetica').fontSize(9).fillColor(ink);
  };
  drawHeader();
  const fmtQty = q => String(Number(q)).replace('.', ',');
  for (const l of t.lines) {
    const h = Math.max(14, doc.heightOfString(l.desc || ' ', { width: cols[0].w - 8 }));
    if (y + h > doc.page.height - 200) { doc.addPage(); y = 48; drawHeader(); }
    let x = X;
    // Línea de título (sin cantidad ni precio): solo el texto, en negrita
    if (!l.qty && !l.price) {
      doc.font('Helvetica-Bold').text(l.desc, x + 4, y, { width: W - 8 }).font('Helvetica');
      y += h + 6;
      continue;
    }
    const vals = { desc: l.desc, qty: fmtQty(l.qty), price: money(l.price), dto: l.dto ? `${fmtQty(l.dto)} %` : '', iva: `${l.iva} %`, importe: money(l.importe) };
    for (const c of cols) { if (showPrices || ['desc', 'qty'].includes(c.k)) doc.text(vals[c.k], x + 4, y, { width: c.w - 8, align: c.a }); x += c.w; }
    y += h + 6;
    doc.moveTo(X, y - 3).lineTo(X + W, y - 3).strokeColor('#eeeeee').stroke();
  }

  // Totales
  if (showPrices) {
    y += 8;
    const tx = X + W * 0.5, tw = W * 0.5;
    const row = (label, value, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 9.5).fillColor(ink);
      doc.text(label, tx, y, { width: tw * 0.6 }); doc.text(value, tx + tw * 0.6, y, { width: tw * 0.4, align: 'right' });
      y += bold ? 20 : 15;
    };
    row('Base imponible', money(t.base));
    for (const g of t.ivas) {
      row(`IVA ${g.rate} %${t.ivas.length > 1 ? ` s/ ${money(g.base)}` : ''}`, money(g.cuota));
      if (g.re) row(`Recargo de equivalencia ${String(g.reRate).replace('.', ',')} %`, money(g.re));
    }
    if (t.retencion) row(`Retención IRPF ${d.irpf} %`, '−' + money(t.retencion));
    doc.moveTo(tx, y).lineTo(X + W, y).strokeColor(ink).stroke(); y += 6;
    row('TOTAL', money(t.total), true);
  }

  // Pie: forma de pago, notas, pie legal y huella
  y += 10;
  doc.font('Helvetica').fontSize(9).fillColor(ink);
  if (d.forma_pago || d.iban) { doc.text([d.forma_pago ? `Forma de pago: ${d.forma_pago}` : '', d.iban ? `IBAN: ${d.iban}` : ''].filter(Boolean).join('   ·   '), X, y, { width: W }); y = doc.y + 6; }
  if (d.notes) { doc.fillColor(muted).text(d.notes, X, y, { width: W }); y = doc.y + 6; }
  if (type === 'albaran') { doc.fillColor(ink).text('Recibí conforme (firma y fecha):', X, y + 16); }
  const foot = [company.doc_footer, hash ? `Huella: ${hash.slice(0, 32)}…` : ''].filter(Boolean).join('\n');
  if (foot) doc.fillColor(muted).fontSize(7.5).text(foot, X, doc.page.height - 70, { width: W, align: 'center' });
  doc.end();
  return done;
}

module.exports = { TYPES, STATES, cleanDraft, totals, numberFor, toExtracted, toText, chainHash, renderPdf, isoToEs };
