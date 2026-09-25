'use strict';
/*
 * Reconocimiento de facturas, albaranes, pedidos y presupuestos.
 *   1. Obtener texto: capa de texto del PDF (pdfjs) o OCR (tesseract.js) para imágenes y PDFs escaneados.
 *   2. Extraer campos con heurísticas para documentos españoles.
 *   3. Validar (NIF, cuadre base + IVA = total, fechas).
 */
const path = require('node:path');
const { DATA_DIR } = require('./db');

// ---------------------------------------------------------------- texto

let workerPromise = null;
function getOcrWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    // La primera vez descarga spa.traineddata y lo guarda en data/tessdata.
    const cachePath = path.join(DATA_DIR, 'tessdata');
    require('node:fs').mkdirSync(cachePath, { recursive: true });
    workerPromise = createWorker('spa', 1, { cachePath });
  }
  return workerPromise;
}

async function ocrImage(buffer) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  return { text: data.text || '', confidence: typeof data.confidence === 'number' ? data.confidence : null };
}

let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

// Reconstruye líneas agrupando los fragmentos de texto por su coordenada Y.
function pageItemsToText(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let row = rows.find(r => Math.abs(r.y - y) < 3);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, str: it.str, w: it.width || 0 });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    r.parts.sort((a, b) => a.x - b.x);
    let line = '', end = null;
    for (const p of r.parts) {
      if (end !== null) line += (p.x - end > 12 ? '   ' : (p.x - end > 1 ? ' ' : ''));
      line += p.str;
      end = p.x + p.w;
    }
    return line.trim();
  }).join('\n');
}

async function pdfToText(buffer) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  const maxPages = Math.min(doc.numPages, 5);
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(pageItemsToText(content.items));
  }
  const text = pages.join('\n\n');
  if (text.replace(/\s/g, '').length >= 30) return { text, confidence: 100, method: 'pdf-texto' };

  // PDF escaneado: renderizar páginas a imagen y pasar OCR.
  const { createCanvas } = require('@napi-rs/canvas');
  const out = [];
  let confSum = 0;
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const r = await ocrImage(canvas.toBuffer('image/png'));
    out.push(r.text);
    confSum += r.confidence || 0;
  }
  return { text: out.join('\n\n'), confidence: out.length ? confSum / out.length : null, method: 'pdf-ocr' };
}

async function getText(buffer, mime, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return pdfToText(buffer);
  if (/^text\/|xml/.test(mime || '') || ['.txt', '.xml'].includes(ext)) {
    let text = buffer.toString('utf8');
    if (ext === '.xml' || /xml/.test(mime || '')) text = text.replace(/<[^>]+>/g, '\n').replace(/\n\s*\n+/g, '\n');
    return { text, confidence: 100, method: 'texto' };
  }
  const r = await ocrImage(buffer);
  return { ...r, method: 'ocr' };
}

// ---------------------------------------------------------------- utilidades

const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const round2 = n => Math.round(n * 100) / 100;

// "1.234,56" | "1234,56" | "1,234.56" | "1234.56" | "1 234,56" -> número
function parseAmount(raw) {
  let s = String(raw).replace(/[€\s]/g, '').replace(/EUR/i, '');
  if (!/\d/.test(s)) return null;
  const neg = /^-/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  const lastC = s.lastIndexOf(','), lastD = s.lastIndexOf('.');
  if (lastC > -1 && lastD > -1) {
    const dec = lastC > lastD ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastC > -1) {
    const tail = s.length - lastC - 1;
    s = (tail === 3 && s.split(',').length > 1 && !/^0,/.test(s)) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
    if (s.split('.').length > 2) s = s.replace(/\.(?=.*\.)/g, '');
  } else if (lastD > -1) {
    const parts = s.split('.');
    const tail = s.length - lastD - 1;
    if (parts.length > 2 || tail === 3) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

// Importes de una línea (excluye porcentajes, fechas y códigos largos)
function amountsIn(line) {
  const clean = line.replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, ' ');
  const re = /-?\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|-?\d+(?:[.,]\d{1,2})?(?![\d])/g;
  const out = [];
  let m;
  while ((m = re.exec(clean))) {
    const after = clean.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const before = clean.slice(Math.max(0, m.index - 1), m.index);
    if (/^\s?%/.test(after)) continue;
    if (/[A-Za-z]/.test(before)) continue;
    const hasDecimals = /[.,]\d{1,2}$/.test(m[0]);
    const hasEuro = /^\s?(€|eur)/i.test(after);
    if (!hasDecimals && !hasEuro) continue;
    const v = parseAmount(m[0]);
    if (v !== null) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------- NIF / CIF / NIE

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
function validDniNie(v) {
  let s = v.toUpperCase();
  if (/^[XYZ]/.test(s)) s = 'XYZ'.indexOf(s[0]) + s.slice(1);
  if (!/^\d{8}[A-Z]$/.test(s)) return false;
  return DNI_LETTERS[parseInt(s.slice(0, 8), 10) % 23] === s[8];
}
function validCif(v) {
  const s = v.toUpperCase();
  if (!/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(s)) return false;
  const digits = s.slice(1, 8);
  let even = 0, odd = 0;
  for (let i = 0; i < 7; i++) {
    const d = +digits[i];
    if (i % 2 === 0) { const x = d * 2; odd += Math.floor(x / 10) + (x % 10); } else even += d;
  }
  const c = (10 - ((even + odd) % 10)) % 10;
  const ctrl = s[8];
  if (/[PQRSNW]/.test(s[0])) return ctrl === 'JABCDEFGHI'[c];
  if (/[ABEH]/.test(s[0])) return ctrl === String(c);
  return ctrl === String(c) || ctrl === 'JABCDEFGHI'[c];
}
function validNif(v) { return validCif(v) || validDniNie(v); }

const TO_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', T: '7', B: '8' };
const TO_LETTER = { 8: 'B', 0: 'D', 6: 'G', 5: 'S', 2: 'Z', 7: 'T', 4: 'A', 1: 'J' };
function ocrNifCandidates(raw) {
  const s = raw.toUpperCase();
  const dig = c => /\d/.test(c) ? c : TO_DIGIT[c] || c;
  const let_ = c => /[A-Z]/.test(c) ? c : TO_LETTER[c] || c;
  const mid = [...s.slice(1, 8)].map(dig).join('');
  const lastOpts = [...new Set([s[8], dig(s[8]), let_(s[8])])];
  const out = [];
  for (const last of lastOpts) {
    out.push(let_(s[0]) + mid + last);            // CIF / NIE
    out.push(dig(s[0]) + mid + let_(last));       // DNI
  }
  return [...new Set(out)];
}

function findNifs(text) {
  const found = [];
  const spans = [];
  const push = (val, index, len) => {
    if (spans.some(([a, b]) => index < b && index + len > a)) return;
    spans.push([index, index + len]);
    const v = val.toUpperCase();
    if (!found.some(f => f.value === v)) found.push({ value: v, valid: validNif(v), index });
  };
  const patterns = [
    /\b(?:ES[ \-]?)?([ABCDEFGHJNPQRSUVW])[ \-.]?(\d{7})[ \-.]?([0-9A-J])\b/gi,
    /\b([XYZ])[ \-.]?(\d{7})[ \-.]?([A-Z])\b/gi,
    /\b(\d{8})[ \-.]?([A-Z])\b/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) push(m.slice(1).join(''), m.index, m[0].length);
  }
  // Valor tras la etiqueta "CIF/NIF" que no encaja en ningún patrón: suele ser un error típico
  // del OCR (8↔B, 0↔O/D, 5↔S, 1↔I...). Se prueban sustituciones y, si ninguna valida, se devuelve tal cual.
  const labelRe = /\b(?:c\.?\s?i\.?\s?f|n\.?\s?i\.?\s?f|d\.?\s?n\.?\s?i|nie|vat)\.?(?:\s*\/\s*(?:c\.?i\.?f|n\.?i\.?f))?\s*(?:n[ºo°.]*)?\s*[:\-]?\s*((?:ES)?[A-Z0-9][A-Z0-9 .\-]{7,11})/gi;
  let m;
  while ((m = labelRe.exec(text))) {
    const start = m.index + m[0].length - m[1].length;
    if (spans.some(([a, b]) => start < b && start + m[1].length > a)) continue;
    const raw = m[1].toUpperCase().replace(/[\s.\-]/g, '').replace(/^ES(?=[A-Z0-9]{9}$)/, '');
    if (raw.length < 9) continue;
    const fixed = ocrNifCandidates(raw.slice(0, 9)).find(validNif);
    const value = fixed || raw;
    spans.push([start, start + m[1].length]);
    if (!found.some(f => f.value === value)) found.push({ value, valid: !!fixed, index: start, ocrFixedFrom: fixed && fixed !== raw ? raw : undefined });
  }
  return found.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------- fechas

const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12 };

function datesIn(line) {
  const out = [];
  const n = norm(line);
  let m;
  const re1 = /\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})\b/g;
  while ((m = re1.exec(n))) out.push(mk(+m[1], +m[2], +m[3]));
  const re2 = /\b(\d{1,2})\s*(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sept?|oct|nov|dic)\.?\s*(?:de\s+|del\s+|[\/\-]\s*)?(\d{4})\b/g;
  while ((m = re2.exec(n))) out.push(mk(+m[1], MONTHS[m[2]], +m[3]));
  const re3 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = re3.exec(n))) out.push(mk(+m[3], +m[2], +m[1]));
  return out.filter(Boolean);
  function mk(d, mo, y) {
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    return `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`;
  }
}

// ---------------------------------------------------------------- extracción

const LEGAL_FORM = /\b(s\.?\s?l\.?\s?u\.?|s\.?\s?l\.?|s\.?\s?a\.?\s?u\.?|s\.?\s?a\.?|s\.?\s?c\.?\s?p\.?|c\.?\s?b\.?|s\.?\s?coop\.?|sociedad limitada|sociedad anonima)(?=$|[\s,.;])/i;
const LABEL_WORDS = /^(factura|fecha|cliente|proveedor|albaran|pedido|presupuesto|oferta|n[ºo°]|numero|nif|cif|dni|direccion|telefono|tel|email|e-mail|web|pagina|forma de pago|datos|emisor|destinatario|base|iva|total|concepto|descripcion|cantidad|precio|importe)\b/;

function detectType(lines) {
  const scores = { factura: 0, albaran: 0, pedido: 0, presupuesto: 0 };
  lines.forEach((l, i) => {
    const n = norm(l);
    const w = i < 12 ? 3 : 1;
    if (/\bfactura\b|\bfra\.?\s|ticket|factura simplificada/.test(n)) scores.factura += w;
    if (/\balbaran\b|nota de entrega|hoja de entrega|delivery note/.test(n)) scores.albaran += w * 1.2;
    if (/\bpedido\b|orden de compra|hoja de pedido|purchase order/.test(n)) scores.pedido += w;
    if (/\bpresupuesto\b|\boferta\b|\bcotizacion\b/.test(n)) scores.presupuesto += w;
  });
  // "Pedido nº" aparece a menudo como referencia dentro de albaranes y facturas
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'factura';
}

function findNumber(lines, docType) {
  const typeWord = { factura: 'factura|fra', albaran: 'albaran', pedido: 'pedido', presupuesto: 'presupuesto|oferta' }[docType];
  const token = '([A-Z0-9][A-Z0-9\\-\\/\\.]{0,24})';
  const sep = '[\\s:\\-—–]*';
  const res = [
    new RegExp(`(?:${typeWord})\\s*(?:simplificada\\s*)?(?:n\\.?\\s?[ºo°]\\.?|num(?:ero)?\\.?|nro\\.?|#)?\\s*(?:de\\s+(?:${typeWord}))?${sep}${token}`, 'gi'),
    new RegExp(`(?:n\\.?\\s?[ºo°]\\.?|num(?:ero)?\\.?|nro\\.?|#)\\s*(?:de\\s+)?(?:${typeWord})?${sep}${token}`, 'gi'),
  ];
  const isGood = t => t && /\d/.test(t) && !/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(t) && !validNif(t) && t.length >= 2;
  // Recorre las líneas de arriba abajo: el número suele estar en la cabecera, no en el pie
  let headerAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]).toUpperCase();
    for (const re of res) {
      for (const m of n.matchAll(re)) {
        const t = m[1].replace(/[.\-\/]+$/, '');
        if (isGood(t)) return originalCase(lines[i], t);
        if (headerAt < 0 && m.index + m[0].length >= n.length - 1) headerAt = i;
      }
    }
  }
  // Cabecera en una línea ("Nº factura") y valor al principio de la siguiente
  if (headerAt >= 0) {
    const next = (lines[headerAt + 1] || '').trim().split(/\s+/)[0];
    if (isGood(next)) return next;
  }
  return null;
  function originalCase(line, t) {
    const idx = norm(line).toUpperCase().indexOf(t);
    return idx >= 0 ? line.substr(idx, t.length) : t;
  }
}

function findDates(lines) {
  let fecha = null, vencimiento = null, any = null;
  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]);
    const ds = datesIn(lines[i]);
    const nextDs = ds.length ? ds : datesIn(lines[i + 1] || '');
    if (!any && ds.length) any = ds[0];
    if (/vencimiento|vto\.?|fecha limite|pagar antes/.test(n)) { if (!vencimiento && nextDs.length) vencimiento = nextDs[nextDs.length - 1]; continue; }
    if (/fecha/.test(n) && !/entrega|pedido|nacimiento/.test(n) && !fecha && nextDs.length) fecha = nextDs[0];
  }
  return { fecha: fecha || any, vencimiento };
}

function findTotals(lines) {
  const cand = { base: [], iva: [], total: [] };
  let ivaRate = null;
  const classify = n => {
    if (/base\s*imponible|\bbase\b|subtotal|importe neto|total neto|neto\b|suma/.test(n)) return 'base';
    if (/total\s*(de\s*)?iva|cuota(\s*iva)?|\biva\b|i\.v\.a|impuesto/.test(n) && !/total\s*(factura|a pagar|documento|albaran|pedido)|iva incluido|iva incl/.test(n)) return 'iva';
    if (/\btotal\b|importe total|a pagar|liquido/.test(n)) return 'total';
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]);
    const rate = n.match(/(?:iva|i\.v\.a\.?|impuesto)[^\d]{0,12}(\d{1,2}(?:[.,]\d{1,2})?)\s*%|(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*(?:de\s*)?(?:iva|i\.v\.a)/);
    if (rate && ivaRate === null) ivaRate = parseAmount(rate[1] || rate[2]);

    // Cabecera tabular: "Base imponible   IVA   Total" y valores en la línea siguiente
    const heads = [];
    const segs = lines[i].split(/\s{2,}|\t|\|/).map(s => norm(s.trim())).filter(Boolean);
    for (const s of segs) { const c = classify(s); if (c) heads.push(c); }
    const own = amountsIn(lines[i]);
    if (heads.length >= 2 && own.length === 0) {
      const next = amountsIn(lines[i + 1] || '');
      if (next.length >= heads.length) {
        const vals = next.slice(-heads.length);
        heads.forEach((h, k) => cand[h].push({ v: vals[k], p: 2, i }));
        continue;
      }
    }
    const kind = classify(n);
    if (!kind) continue;
    let vals = own;
    if (!vals.length) vals = amountsIn(lines[i + 1] || '');
    if (!vals.length) continue;
    const priority = kind === 'total' && /total\s*(factura|a pagar|documento)|importe total|total\s*€|total eur/.test(n) ? 3 : 1;
    cand[kind].push({ v: vals[vals.length - 1], p: priority, i });
  }
  const pick = (arr, preferLargest) => {
    if (!arr.length) return null;
    const maxP = Math.max(...arr.map(a => a.p));
    const top = arr.filter(a => a.p === maxP);
    return (preferLargest ? top.sort((a, b) => b.v - a.v)[0] : top[top.length - 1]).v;
  };
  let base = pick(cand.base, false), iva = pick(cand.iva, false), total = pick(cand.total, true);
  const derived = [];
  if (base !== null && iva === null && ivaRate !== null) { iva = round2(base * ivaRate / 100); derived.push('iva'); }
  if (base !== null && iva !== null && total === null) { total = round2(base + iva); derived.push('total'); }
  if (total !== null && base === null && iva !== null) { base = round2(total - iva); derived.push('base'); }
  if (total !== null && base === null && iva === null && ivaRate !== null) { base = round2(total / (1 + ivaRate / 100)); iva = round2(total - base); derived.push('base', 'iva'); }
  if (ivaRate === null && base && iva) {
    const r = Math.round(iva / base * 100);
    if ([4, 5, 10, 21].includes(r)) { ivaRate = r; derived.push('iva_tipo'); }
  }
  return { base, iva, iva_tipo: ivaRate, total, derived };
}

// "CR Coffe Binz SL Calle Orense 62" -> "CR Coffe Binz SL"
function cutAfterLegalForm(l) {
  const m = LEGAL_FORM.exec(l);
  return m ? l.slice(0, m.index + m[0].length) : l;
}

function findParty(lines, nifs, ownNif, ownName) {
  const own = ownName ? norm(ownName) : null;
  const notOwn = l => !own || !norm(l).includes(own);
  const cleanName = l => cutAfterLegalForm(l).replace(/\b(?:c\.?i\.?f|n\.?i\.?f)\.?\s*[:\-]?\s*\S+/i, '').replace(/^(proveedor|emisor|raz[oó]n social|de)\s*[:\-]\s*/i, '').replace(/\s{2,}.*$/, '').trim();
  const top = lines.slice(0, 25);
  for (const l of top) {
    if (LEGAL_FORM.test(l) && notOwn(l) && !/^\s*(cliente|destinatario|facturar a)/i.test(l)) return cleanName(l);
  }
  const provNif = nifs.find(f => f.value !== ownNif);
  if (provNif) {
    const idx = lines.findIndex(l => l.toUpperCase().replace(/[\s\-.]/g, '').includes(provNif.value));
    for (let k = idx; k >= Math.max(0, idx - 3); k--) {
      const c = cleanName(lines[k] || '');
      if (c.length >= 3 && /[a-z]{3}/i.test(c) && !LABEL_WORDS.test(norm(c)) && notOwn(c)) return c;
    }
  }
  for (const l of top) {
    const c = cleanName(l);
    if (c.length >= 3 && /[a-z]{3}/i.test(c) && !LABEL_WORDS.test(norm(c)) && !datesIn(c).length && notOwn(c)) return c;
  }
  return null;
}

function findPayment(lines) {
  let forma = null, iban = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], n = norm(l);
    const ib = l.replace(/\s/g, '').match(/ES\d{22}/i);
    if (ib && !iban) iban = ib[0].toUpperCase().replace(/(.{4})/g, '$1 ').trim();
    if (!forma) {
      const m = n.match(/forma de pago\s*[:\-]?\s*(.+)|(transferencia|domiciliacion|recibo|contado|efectivo|tarjeta|bizum|confirming|pagare)[^\n]*/);
      if (m) {
        // Recupera mayúsculas y acentos del texto original
        const frag = (m[1] || m[0]).trim();
        const at = n.indexOf(frag);
        forma = (at >= 0 && n.length === l.length ? l.substr(at, frag.length) : frag).slice(0, 60) || null;
      }
      if (m && !m[1] && /forma de pago/.test(n) && lines[i + 1]) forma = lines[i + 1].trim().slice(0, 60);
    }
  }
  return { forma_pago: forma, iban };
}

function findLines(lines) {
  const start = lines.findIndex(l => /descripci|concepto|articulo|producto|referencia|detalle/.test(norm(l)) && /cant|uds|unid|importe|precio|total/.test(norm(l)));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && out.length < 60; i++) {
    const n = norm(lines[i]);
    if (/base imponible|subtotal|total|suma|forma de pago|observaciones|\biva\b/.test(n)) break;
    // Columnas numéricas al final de la línea: [cantidad] [precio] importe
    const tokens = lines[i].replace(/€/g, ' ').split(/\s+/).filter(Boolean);
    let k = tokens.length;
    while (k > 0 && /^-?\d+(?:[.,]\d+)*%?$/.test(tokens[k - 1])) k--;
    const nums = tokens.slice(k).filter(t => !/%$/.test(t)).map(parseAmount).filter(v => v !== null);
    const desc = tokens.slice(0, k).join(' ');
    if (!nums.length || !/[a-z]{2}/i.test(desc)) continue;
    out.push({ descripcion: desc.slice(0, 80), cantidad: nums.length >= 2 ? nums[0] : null, precio: nums.length >= 3 ? nums[nums.length - 2] : null, importe: nums[nums.length - 1] });
  }
  return out;
}

function extractFields(text, opts = {}) {
  const lines = String(text).replace(/\r/g, '').split('\n').map(l => l.replace(/[|]{2,}/g, ' ').trim()).filter(Boolean);
  const ownNif = opts.ownNif ? opts.ownNif.toUpperCase().replace(/[\s\-.]/g, '').replace(/^ES/, '') : null;
  const doc_type = detectType(lines);
  const nifs = findNifs(text);
  const partyNifs = nifs.filter(f => f.value !== ownNif);
  const nif = (partyNifs.find(f => f.valid) || partyNifs[0] || null);
  const totals = findTotals(lines);
  const dates = findDates(lines);
  const pay = findPayment(lines);

  const fields = {
    proveedor: findParty(lines, nifs, ownNif, opts.ownName),
    nif: nif ? nif.value : null,
    numero: findNumber(lines, doc_type),
    fecha: dates.fecha,
    vencimiento: dates.vencimiento,
    base: totals.base,
    iva_tipo: totals.iva_tipo,
    iva: totals.iva,
    total: totals.total,
    forma_pago: pay.forma_pago,
    iban: pay.iban,
  };

  const checks = [];
  if (nif?.ocrFixedFrom) checks.push({ id: 'nif_ocr', ok: true, warn: true, msg: `NIF corregido automáticamente: el OCR leyó "${nif.ocrFixedFrom}"` });
  if (fields.nif) checks.push({ id: 'nif', ok: validNif(fields.nif), msg: validNif(fields.nif) ? 'NIF/CIF con dígito de control válido' : 'NIF/CIF con dígito de control incorrecto (posible error de lectura)' });
  else checks.push({ id: 'nif', ok: false, msg: 'No se ha encontrado NIF/CIF del proveedor' });
  if (fields.base !== null && fields.iva !== null && fields.total !== null) {
    const diff = Math.abs(fields.base + fields.iva - fields.total);
    checks.push({ id: 'cuadre', ok: diff <= 0.05, msg: diff <= 0.05 ? 'Base + IVA = Total' : `Base + IVA no cuadra con el total (diferencia ${diff.toFixed(2)} €)` });
  } else if (doc_type === 'factura') {
    checks.push({ id: 'cuadre', ok: false, msg: 'Faltan importes para comprobar el cuadre' });
  }
  if (totals.derived.length) checks.push({ id: 'derivados', ok: true, warn: true, msg: `Calculado a partir de otros campos: ${totals.derived.join(', ')}` });
  checks.push({ id: 'fecha', ok: !!fields.fecha, msg: fields.fecha ? 'Fecha detectada' : 'No se ha encontrado la fecha' });
  checks.push({ id: 'numero', ok: !!fields.numero, msg: fields.numero ? 'Número de documento detectado' : 'No se ha encontrado el número de documento' });

  const keys = doc_type === 'factura' ? ['proveedor', 'nif', 'numero', 'fecha', 'base', 'iva', 'total'] : ['proveedor', 'nif', 'numero', 'fecha'];
  const found = keys.filter(k => fields[k] !== null && fields[k] !== '').length;
  const coverage = found / keys.length;
  const okChecks = checks.filter(c => !c.warn);
  const checkScore = okChecks.length ? okChecks.filter(c => c.ok).length / okChecks.length : 0;

  return {
    doc_type,
    fields,
    lines: findLines(lines),
    checks,
    derived: totals.derived,
    all_nifs: nifs,
    score: Math.round((coverage * 0.6 + checkScore * 0.4) * 1000) / 10,
  };
}

async function analyze(buffer, { mime, filename, ownNif, ownName } = {}) {
  const t = await getText(buffer, mime, filename);
  const result = extractFields(t.text, { ownNif, ownName });
  return { ...result, raw_text: t.text, ocr_confidence: t.confidence, method: t.method };
}

module.exports = { analyze, extractFields, parseAmount, validNif, datesIn };
