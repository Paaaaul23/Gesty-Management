'use strict';
/*
 * Reconocimiento de facturas, albaranes, pedidos y presupuestos.
 *   1. Maquetación: filas y bloques de texto con su posición en la página, desde la capa de
 *      texto del PDF (pdfjs) o desde el OCR (tesseract.js) para fotos y PDFs escaneados.
 *   2. Pares etiqueta → valor (a la derecha, debajo o en la misma frase) y tablas por columnas.
 *   3. Campos con reglas para documentos españoles, validados entre sí (NIF, IBAN,
 *      base + IVA + recargo − retención = total, suma de líneas = base).
 *   4. Opcional: lectura con IA (ai.js) que se combina con la local y pasa las mismas comprobaciones.
 */
const path = require('node:path');
const { DATA_DIR } = require('./db');

// ================================================================ utilidades

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const round2 = n => Math.round(n * 100) / 100;
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const isEmpty = v => v === null || v === undefined || v === '';

// "1.234,56" | "1234,56" | "1,234.56" | "1234.56" | "1 234,56" -> número
function parseAmount(raw) {
  let s = String(raw).replace(/[€\s]/g, '').replace(/EUR/i, '');
  if (!/\d/.test(s)) return null;
  const neg = /^-/.test(s) || /^\(.*\)$/.test(s) || /-$/.test(s);
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

// Importes de un texto (excluye porcentajes, fechas, teléfonos y códigos largos)
function amountsIn(line, { loose = false } = {}) {
  const clean = String(line).replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, ' ');
  const re = /-?\s?€?\s?\d{1,3}(?:[.\s]\d{3})+(?:[.,]\d{1,2})?(?![\d])|-?\s?€?\s?\d+(?:[.,]\d{1,2})?(?![\d])/g;
  const out = [];
  let m;
  while ((m = re.exec(clean))) {
    const txt = m[0].replace(/\s/g, '');
    const after = clean.slice(m.index + m[0].length, m.index + m[0].length + 4);
    const before = clean.slice(Math.max(0, m.index - 1), m.index);
    if (/^\s?%/.test(after)) continue;
    if (/[A-Za-z]/.test(before) && !/€/.test(txt)) continue;
    const hasDecimals = /[.,]\d{1,2}$/.test(txt);
    const hasEuro = /€/.test(txt) || /^\s?(€|eur)/i.test(after);
    if (!hasDecimals && !hasEuro && !loose) continue;
    const v = parseAmount(txt);
    if (v !== null) out.push(v);
  }
  return out;
}

// ================================================================ capa de texto con posiciones
// Resultado común: rows = [{ y, h, segs: [{ x0, x1, y, h, text }] }] ordenadas de arriba abajo.
// Un "seg" es un bloque de palabras juntas; los huecos grandes separan columnas.

function buildRows(words, { gapFactor = 1.1 } = {}) {
  const ws = words.filter(w => w.text && w.text.trim()).map(w => ({ ...w, text: w.text.replace(/\s+/g, ' ').trim(), yc: w.y + w.h / 2 }));
  if (!ws.length) return [];
  ws.sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
  const rows = [];
  for (const w of ws) {
    // Busca una fila existente con el centro vertical cerca (tolera pequeños giros)
    let row = null;
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 4); i--) {
      const r = rows[i];
      if (Math.abs(r.yc - w.yc) < Math.min(r.h, w.h) * 0.55) { row = r; break; }
    }
    if (!row) { row = { yc: w.yc, h: w.h, words: [] }; rows.push(row); }
    row.words.push(w);
    row.yc = row.words.reduce((a, b) => a + b.yc, 0) / row.words.length;
    row.h = median(row.words.map(x => x.h));
  }
  rows.sort((a, b) => a.yc - b.yc);
  return rows.map(r => {
    r.words.sort((a, b) => a.x0 - b.x0);
    const segs = [];
    for (const w of r.words) {
      const last = segs[segs.length - 1];
      const gap = last ? w.x0 - last.x1 : Infinity;
      if (last && gap < Math.max(r.h, w.h) * gapFactor) {
        last.text += (gap > Math.min(last.h, w.h) * 0.12 ? ' ' : '') + w.text;
        last.x1 = Math.max(last.x1, w.x1);
        last.h = Math.max(last.h, w.h);
      } else segs.push({ x0: w.x0, x1: w.x1, y: r.yc, h: w.h, text: w.text });
    }
    return { y: r.yc, h: r.h, segs };
  });
}

const rowsToText = rows => rows.map(r => r.segs.map(s => s.text).join('   ')).join('\n');

// Texto plano (TXT, XML): cada línea es una fila y los huecos de 2+ espacios separan columnas
function textToRows(text) {
  const CH = 7, LH = 14;
  return String(text).replace(/\r/g, '').split('\n').map((line, i) => {
    const segs = [];
    const re = /\S+(?: \S+)*/g;
    let m;
    while ((m = re.exec(line.replace(/\t/g, '    ')))) segs.push({ x0: m.index * CH, x1: (m.index + m[0].length) * CH, y: i * LH, h: 10, text: m[0] });
    return { y: i * LH, h: 10, segs };
  }).filter(r => r.segs.length);
}

// Dos lectores: uno para páginas completas y otro para zonas (modo "bloque de texto uniforme")
const workers = {};
function getOcrWorker(kind = 'page') {
  if (!workers[kind]) {
    const { createWorker } = require('tesseract.js');
    // La primera vez descarga spa.traineddata y lo guarda en data/tessdata.
    const cachePath = path.join(DATA_DIR, 'tessdata');
    require('node:fs').mkdirSync(cachePath, { recursive: true });
    workers[kind] = createWorker('spa', 1, { cachePath }).then(async w => {
      await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300', tessedit_pageseg_mode: kind === 'zone' ? '6' : '3' });
      return w;
    });
  }
  return workers[kind];
}

let canvasMod;
function getCanvas() {
  if (canvasMod === undefined) { try { canvasMod = require('@napi-rs/canvas'); } catch { canvasMod = null; } }
  return canvasMod;
}

// Normaliza la imagen para el OCR: escala de grises y tamaño suficiente para letra pequeña.
async function prepareImage(buffer) {
  const cv = getCanvas();
  if (!cv) return buffer;
  try {
    const img = await cv.loadImage(buffer);
    const w = img.width, h = img.height;
    // Ampliar de más hace que Tesseract descarte líneas: ~1400 px de ancho da el mejor resultado
    const scale = Math.min(3, Math.max(1, 1400 / Math.max(w, 1)));
    const canvas = cv.createCanvas(Math.round(w * scale), Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.filter = 'grayscale(1)';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toBuffer('image/png');
  } catch { return buffer; }
}

async function ocrLayout(buffer, { prepared = false } = {}) {
  const worker = await getOcrWorker();
  const img = prepared ? buffer : await prepareImage(buffer);
  const { data } = await worker.recognize(img, { rotateAuto: true }, { blocks: true, text: true });
  const words = [];
  const angles = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const bl = l.baseline;
    if (bl && bl.x1 - bl.x0 > 150) angles.push(Math.atan2(bl.y1 - bl.y0, bl.x1 - bl.x0));
    for (const w of l.words || []) {
      if (w.confidence < 15 && !/[A-Za-z0-9]{2}/.test(w.text)) continue;
      words.push({ x0: w.bbox.x0, x1: w.bbox.x1, y: w.bbox.y0, h: Math.max(4, w.bbox.y1 - w.bbox.y0), text: w.text });
    }
  }
  // Foto torcida: se enderezan las coordenadas con el ángulo medio de las líneas base,
  // para que las filas de una tabla no se partan en dos
  const angle = median(angles);
  if (Math.abs(angle) > 0.002) {
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    for (const w of words) {
      const cx = (w.x0 + w.x1) / 2, cy = w.y + w.h / 2;
      const nx = cx * cos - cy * sin, ny = cx * sin + cy * cos;
      const half = (w.x1 - w.x0) / 2;
      w.x0 = nx - half; w.x1 = nx + half; w.y = ny - w.h / 2;
    }
  }
  const rows = buildRows(words, { gapFactor: 1.25 });
  return { rows, text: rowsToText(rows) || data.text || '', confidence: typeof data.confidence === 'number' ? data.confidence : null, image: img };
}

// Segunda lectura de zonas concretas (cabecera izquierda y derecha, totales). El análisis de la
// página completa a veces mezcla una línea pequeña con un título grande y la lee mal; leída sola sale bien.
async function ocrZones(image, zones) {
  const cv = getCanvas();
  if (!cv || !image) return [];
  const img = await cv.loadImage(image);
  const worker = await getOcrWorker('zone');
  const out = [];
  for (const [fx, fy, fw, fh] of zones) {
    const x = Math.round(img.width * fx), y = Math.round(img.height * fy), w = Math.round(img.width * fw), h = Math.round(img.height * fh);
    const c = cv.createCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.drawImage(img, x, y, w, h, 0, 0, w, h);
    const { data } = await worker.recognize(c.toBuffer('image/png'), {}, { blocks: true });
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
      words.push({ x0: wd.bbox.x0 + x, x1: wd.bbox.x1 + x, y: wd.bbox.y0 + y, h: Math.max(4, wd.bbox.y1 - wd.bbox.y0), text: wd.text });
    }
    out.push(buildRows(words, { gapFactor: 1.25 }));
  }
  return out;
}

let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdfLayout(buffer) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const words = [];
  let offset = 0;
  const maxPages = Math.min(doc.numPages, 5);
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform;
      const h = Math.hypot(c, d) || it.height || 10;
      // Separa los fragmentos que contienen huecos grandes (varias columnas en un mismo item)
      const parts = it.str.split(/(\s{3,})/);
      const cw = (it.width || it.str.length * h * 0.5) / Math.max(1, it.str.length);
      let pos = 0;
      for (const part of parts) {
        if (part.trim() && !/^\s+$/.test(part)) {
          const lead = part.length - part.trimStart().length;
          words.push({ x0: e + (pos + lead) * cw, x1: e + (pos + part.trimEnd().length) * cw, y: offset + (vp.height - f) - h * 0.8, h, text: part.trim() });
        }
        pos += part.length;
      }
    }
    offset += vp.height + 40;
  }
  const rows = buildRows(words, { gapFactor: 0.9 });
  const text = rowsToText(rows);
  if (text.replace(/\s/g, '').length >= 30) return { rows, text, confidence: 100, method: 'pdf-texto' };

  // PDF escaneado: renderizar páginas a imagen y pasar OCR.
  const cv = getCanvas();
  if (!cv) throw new Error('No se puede leer el PDF escaneado: falta @napi-rs/canvas');
  const allRows = [];
  let confSum = 0, n = 0, yOff = 0, firstImage = null;
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.8 });
    const canvas = cv.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const r = await ocrLayout(await prepareImage(canvas.toBuffer('image/png')), { prepared: true });
    if (i === 1) firstImage = r.image;
    for (const row of r.rows) allRows.push({ ...row, y: row.y + yOff, segs: row.segs.map(s => ({ ...s, y: s.y + yOff })) });
    yOff += viewport.height + 100;
    confSum += r.confidence || 0; n++;
  }
  return { rows: allRows, text: rowsToText(allRows), confidence: n ? confSum / n : null, method: 'pdf-ocr', image: firstImage };
}

async function getLayout(buffer, mime, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return pdfLayout(buffer);
  if (/^text\/|xml/.test(mime || '') || ['.txt', '.xml'].includes(ext)) {
    let text = buffer.toString('utf8');
    if (ext === '.xml' || /xml/.test(mime || '')) text = text.replace(/<[^>]+>/g, '\n').replace(/\n\s*\n+/g, '\n');
    return { rows: textToRows(text), text, confidence: 100, method: 'texto' };
  }
  const r = await ocrLayout(buffer);
  return { ...r, method: 'ocr' };
}

// ================================================================ NIF / CIF / NIE / IBAN

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

// Errores típicos del OCR entre letras y números
const TO_DIGIT = { O: '0', D: '0', Q: '0', U: '0', I: '1', L: '1', J: '1', Z: '2', S: '5', G: '6', T: '7', B: '8', A: '4' };
const TO_LETTERS = { 8: ['B'], 0: ['D', 'Q'], 6: ['G'], 5: ['S', 'B'], 2: ['Z'], 7: ['T'], 4: ['A'], 1: ['J'], 3: ['B'], 9: ['B'] };
function ocrNifCandidates(raw) {
  const s = raw.toUpperCase();
  const dig = c => /\d/.test(c) ? c : TO_DIGIT[c] || c;
  const lets = c => /[A-Z]/.test(c) ? [c] : TO_LETTERS[c] || [c];
  const mid = [...s.slice(1, 8)].map(dig).join('');
  const out = [];
  for (const last of new Set([s[8], dig(s[8]), ...lets(s[8])])) {
    for (const first of lets(s[0])) out.push(first + mid + last); // CIF / NIE
    out.push(dig(s[0]) + mid + (lets(last)[0]));                   // DNI
  }
  return [...new Set(out)];
}

const NIF_LABEL = /\b(?:c\.?\s?i\.?\s?f|n\.?\s?i\.?\s?f|d\.?\s?n\.?\s?i|n\.?\s?i\.?\s?e|vat(?:\s*id)?|nif-iva)\.?\s*(?:\/\s*(?:c\.?i\.?f|n\.?i\.?f)\.?)?\s*(?:n[ºo°.]*)?\s*[:\-]?\s*/i;
function nifsInText(text) {
  const found = [];
  const spans = [];
  const push = (val, index, len, extra = {}) => {
    if (spans.some(([a, b]) => index < b && index + len > a)) return;
    spans.push([index, index + len]);
    found.push({ value: val.toUpperCase(), valid: validNif(val), index, ...extra });
  };
  const patterns = [
    /\b(?:ES[ \-]?)?([ABCDEFGHJNPQRSUVW])[ \-.]?(\d{2})[ .]?(\d{3})[ .]?(\d{2})[ \-.]?([0-9A-J])\b/gi,
    /\b([XYZ])[ \-.]?(\d{7})[ \-.]?([A-Z])\b/gi,
    /\b(\d{2})[.]?(\d{3})[.]?(\d{3})[ \-.]?([A-Z])\b/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) push(m.slice(1).join(''), m.index, m[0].length);
  }
  // Valor tras "CIF/NIF" que no encaja en ningún patrón: se prueban las confusiones típicas del OCR
  const labelRe = new RegExp(NIF_LABEL.source + '((?:ES)?[A-Z0-9][A-Z0-9 .\\-]{7,12})', 'gi');
  let m;
  while ((m = labelRe.exec(text))) {
    const start = m.index + m[0].length - m[1].length;
    if (spans.some(([a, b]) => start < b && start + m[1].length > a)) continue;
    const raw = m[1].toUpperCase().replace(/[\s.\-]/g, '').replace(/^ES(?=[A-Z0-9]{9})/, '');
    if (raw.length < 9) continue;
    const cand = raw.slice(0, 9);
    const fixed = ocrNifCandidates(cand).find(validNif);
    push(fixed || cand, start, m[1].length, { ocrFixedFrom: fixed && fixed !== cand ? cand : undefined });
    found[found.length - 1].valid = !!fixed;
  }
  return found.sort((a, b) => a.index - b.index);
}

function validIban(iban) {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let mod = 0;
  for (const ch of r) mod = (mod * 10 + +ch) % 97;
  return mod === 1;
}
function findIban(text) {
  const flat = text.replace(/[ \t]/g, '');
  const cands = [];
  const re = /ES[0-9OIl]{2}(?:[0-9OIlSB]{20})/gi;
  let m;
  while ((m = re.exec(flat))) {
    const fixed = 'ES' + m[0].slice(2).replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
    cands.push(fixed.toUpperCase());
  }
  const pick = cands.find(validIban) || cands[0];
  return pick ? { value: pick.replace(/(.{4})/g, '$1 ').trim(), valid: validIban(pick) } : null;
}

// ================================================================ fechas

const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, set: 9, oct: 10, nov: 11, dic: 12 };

function datesIn(line) {
  const out = [];
  const n = norm(line);
  let m;
  const re1 = /\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})\b/g;
  while ((m = re1.exec(n))) out.push(mk(+m[1], +m[2], +m[3]));
  const re2 = /\b(\d{1,2})\s*(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sept?|set|oct|nov|dic)\.?\s*(?:de\s+|del\s+|[\/\-,]\s*)?(\d{4})\b/g;
  while ((m = re2.exec(n))) out.push(mk(+m[1], MONTHS[m[2]], +m[3]));
  const re3 = /\b(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/g;
  while ((m = re3.exec(n))) out.push(mk(+m[3], +m[2], +m[1]));
  return out.filter(Boolean);
  function mk(d, mo, y) {
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    return `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`;
  }
}
const dateKey = d => d ? d.split('/').reverse().join('') : '';

// ================================================================ etiquetas

// Forma canónica de una etiqueta: sin acentos, sin puntuación, "nº"/"número"/"núm." -> "num"
function canon(s) {
  return norm(s)
    .replace(/\bn\s?[º°ºo9s0”“\"'*][o°º]?\s?\.?(?=\s|$|[:\-])|\bn\.\s?[º°o]\.?|\bnum\.?(?:ero)?(?=\s|$|[:\-])|\bnro\.?|\bno\.(?=\s)/g, ' num ')
    .replace(/[()\[\]:;,.·•*_"'¿?]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const DOCW = 'factura|fra|albaran|pedido|presupuesto|documento|doc|nota|nota de entrega|ticket|entrega|serie|invoice|oferta';
const LABELS = {
  numero: new RegExp(`^(?:num(?: de)?(?: (?:${DOCW}))?|(?:${DOCW})(?: simplificada| rectificativa)?(?: num)?|numero|invoice (?:no|number|#)|num doc|referencia factura)$`),
  fecha: /^(?:fecha(?: de)?(?: (?:la )?(?:factura|emision|expedicion|documento|albaran|pedido|entrega|operacion|servicio|presupuesto))?|date|invoice date|fecha factura|f factura|f emision)$/,
  vencimiento: /^(?:(?:fecha(?: de)? )?vencimientos?|vto|f vto|fecha limite(?: de pago)?|fecha de pago|fecha (?:de )?cargo|fecha (?:prevista )?de cobro|fecha de adeudo|pagar antes de|due date|vence)$/,
  base: /^(?:base(?: imponible| imp)?(?: total)?|total base(?: imponible)?|subtotal|sub total|importe neto|total neto|neto|suma|total sin iva|subtotal sin iva|importe sin iva|base iva)$/,
  iva_tipo: /^(?:% ?iva|tipo(?: de)? iva|iva ?%|% i v a|tipo impositivo)$/,
  iva: /^(?:cuota(?: de)?(?: iva)?|iva|i v a|total iva|importe iva|cuota iva|impuestos?|total impuestos)$/,
  recargo: /^(?:recargo(?: de)? equivalencia|rec equiv|rec eq|r e|cuota r ?e|recargo)$/,
  retencion: /^(?:retencion(?: irpf)?|ret irpf|irpf|retencion i r p f)$/,
  total: /^(?:total(?: (?:factura|a pagar|documento|albaran|pedido|presupuesto|eur|euros|€|general|importe|con iva|iva incluido|iva incl|ivа incl|\(iva incl\)|neto a pagar))?|importe total|total importe|importe a pagar|importe pagado|a pagar|liquido(?: a pagar)?|total a abonar|(?:total |liquido |neto |importe )?a percibir|total a cobrar|amount due|total due|total eur|total €)$/,
  forma_pago: /^(?:(?:forma|metodo|modo|medio|condiciones|tipo)(?: de)? (?:pago|cobro)|pago|cobro|pagado con|payment method|medio pago)$/,
  iban: /^(?:iban|cuenta(?: bancaria)?|c c c|ccc|num cuenta|numero de cuenta|domiciliacion|cuenta de abono|cuenta cargo)$/,
};
const CLIENT_LABEL = /^(?:cliente|datos(?: del)? cliente|facturar a|facturado a|destinatario|entregar a|entregado a|enviar a|enviado a|titular(?: del contrato)?|datos del titular|senores|sres|a la atencion de|atencion|solicitante|comprador|bill to|sold to|ship to|direccion de entrega|datos de facturacion|lugar de entrega|receptor)$/;
const SUPPLIER_LABEL = /^(?:proveedor|emisor|vendedor|datos del proveedor|datos del emisor|razon social)$/;
// IVA con el tipo en la propia etiqueta: "IVA 21%", "IVA (10 %) s/ 50,30 €", "21% IVA"
const IVA_RATE_LABEL = /^(?:iva|i v a|cuota(?: de)? iva|cuota)\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%(?:\s*(?:s\/|sobre|de|base)\s*.*)?$|^(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*(?:de )?iva(?:\s*(?:s\/|sobre|de)\s*.*)?$/;
const RATE_LABEL = key => new RegExp(`^(?:${LABELS[key].source.slice(4, -2)})\\s*\\(?-?\\s*(\\d{1,2}(?:[.,]\\d{1,2})?)\\s*%\\)?(?:\\s*(?:s\\/|sobre|de)\\s*.*)?$`);
const RECARGO_RATE = RATE_LABEL('recargo'), RETENCION_RATE = RATE_LABEL('retencion'), BASE_RATE = RATE_LABEL('base');

function labelOf(text) {
  const c = canon(text).replace(/\s(?:eur|euros|€|en euros)$/, '');
  if (!c || c.length > 48) return null;
  let m;
  if ((m = c.match(IVA_RATE_LABEL))) return { key: 'iva', rate: parseAmount(m[1] || m[2]), c };
  if ((m = c.match(RECARGO_RATE))) return { key: 'recargo', rate: parseAmount(m[1]), c };
  if ((m = c.match(RETENCION_RATE))) return { key: 'retencion', rate: parseAmount(m[1]), c };
  if ((m = c.match(BASE_RATE))) return { key: 'base', rate: parseAmount(m[1]), c };
  for (const [key, re] of Object.entries(LABELS)) if (re.test(c)) return { key, c };
  if (CLIENT_LABEL.test(c)) return { key: 'cliente', c };
  if (SUPPLIER_LABEL.test(c)) return { key: 'proveedor', c };
  if (/^(?:c i f|n i f|cif|nif|dni|nie|nif cif|cif nif|vat id|vat)$/.test(c)) return { key: 'nif', c };
  return null;
}

// "Nº Factura: A-1023" -> etiqueta + valor en el mismo bloque
function splitInline(text) {
  const colon = text.match(/^([^:]{2,40}?)\s*:\s*(.+)$/);
  if (colon) { const l = labelOf(colon[1]); if (l) return { ...l, value: colon[2].trim() }; }
  const words = text.split(/\s+/);
  for (let k = Math.min(6, words.length - 1); k >= 1; k--) {
    const l = labelOf(words.slice(0, k).join(' '));
    if (l) return { ...l, value: words.slice(k).join(' ').replace(/^[:\-–—]\s*/, '').trim() };
  }
  return null;
}

// ¿El texto tiene la forma que se espera para esa etiqueta? (evita emparejar con lo que no toca)
function fitsKey(key, text) {
  if (['base', 'iva', 'total', 'recargo', 'retencion'].includes(key)) return amountsIn(text, { loose: true }).length > 0 && !/[a-z]{4}/i.test(text.replace(/eur(os)?/i, ''));
  if (key === 'fecha' || key === 'vencimiento') return datesIn(text).length > 0;
  if (key === 'numero') return /\d/.test(text);
  if (key === 'iva_tipo') return /\d/.test(text);
  return true;
}

const overlapX = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));

// Pares etiqueta → valor: en el mismo bloque, a la derecha o debajo (cabeceras de tabla)
function findPairs(rows) {
  const pairs = [];
  rows.forEach((row, ri) => {
    row.segs.forEach((seg, si) => {
      const pure = labelOf(seg.text);
      if (!pure) {
        for (const part of seg.text.split(/\s+[·|•]\s+|\s{2,}/)) {
          const inl = splitInline(part);
          if (inl && inl.value) pairs.push({ ...inl, row: ri, seg, how: 'inline' });
        }
        return;
      }
      seg.label = pure;
      const right = row.segs[si + 1];
      // "FACTURA" o "ALBARÁN" solos son títulos: solo valen con un código justo a la derecha
      if (pure.key === 'numero' && !/num|invoice|referencia/.test(pure.c)) {
        if (right && /^[A-Z]{0,4}[\-\/.]?\d[A-Z0-9\-\/.]{0,22}$/i.test(right.text.trim()) && !datesIn(right.text).length) pairs.push({ ...pure, value: right.text, row: ri, seg, vseg: right, how: 'right' });
        return;
      }
      if (right && !labelOf(right.text) && fitsKey(pure.key, right.text)) {
        pairs.push({ ...pure, value: right.text, row: ri, seg, vseg: right, how: 'right' });
        return;
      }
      // Debajo: bloque de la fila siguiente que se solapa en horizontal
      for (let k = ri + 1; k < Math.min(rows.length, ri + 3); k++) {
        const below = rows[k];
        if (below.y - row.y > Math.max(row.h, below.h) * 4.5) break;
        let best = null, bestOv = 0;
        for (const s of below.segs) {
          const ov = overlapX(seg, s);
          const cx = (s.x0 + s.x1) / 2;
          const score = ov > 0 ? ov : (cx > seg.x0 - 30 && cx < seg.x1 + 30 ? 1 : 0);
          if (score > bestOv) { best = s; bestOv = score; }
        }
        if (best && !labelOf(best.text) && fitsKey(pure.key, best.text)) { pairs.push({ ...pure, value: best.text, row: k, seg, vseg: best, how: 'below' }); break; }
        if (best) break;
      }
    });
  });
  return pairs;
}

// ================================================================ tipo de documento

function detectType(rows) {
  const scores = { factura: 0, rectificativa: 0, albaran: 0, pedido: 0, presupuesto: 0 };
  const maxH = Math.max(...rows.slice(0, 30).flatMap(r => r.segs.map(s => s.h)), 1);
  rows.forEach((r, i) => {
    for (const s of r.segs) {
      const n = norm(s.text);
      // Los títulos (letra grande, arriba) pesan mucho más que las menciones sueltas
      const w = (i < 15 ? 3 : 1) * (s.h >= maxH * 0.8 ? 3 : 1) * (n.length < 30 ? 1.5 : 1);
      if (/\bfactura\b|\bfra\.?\s|\bticket\b|factura simplificada|\binvoice\b/.test(n)) scores.factura += w;
      if (/\balbaran|nota de entrega|hoja de entrega|delivery note|\bentrega num/.test(n)) scores.albaran += w * 1.2;
      if (/(?:^|\s)pedido\b|orden de compra|hoja de pedido|purchase order/.test(n) && !/su pedido|n[ºo°]? ?pedido cliente|ref.*pedido/.test(n)) scores.pedido += w * (/^pedido$|^hoja de pedido$|^orden de compra$/.test(n.trim()) ? 2 : 0.6);
      if (/\bpresupuesto\b|\boferta\b|\bcotizacion\b|\bproforma\b/.test(n)) scores.presupuesto += w;
      if (/rectificativa|factura de abono|nota de abono|nota de credito|credit note/.test(n)) scores.rectificativa += w * 2.2;
    }
  });
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'factura';
}

// ================================================================ bloques de cliente y proveedor

const ADDRESS = /\b(?:c\/|calle|avda?\.?|avenida|r[uú]a|plaza|pza\.?|pol[ií]gono|pol\.|pg\.?|camino|cami[ñn]o|estrada|paseo|p[ºo]\.?|carretera|ctra\.?|traves[ií]a|urb\.?|urbanizaci[oó]n|lugar|barrio|parcela|nave|local|piso|planta|apartado|mercado|puesto|ronda|glorieta|carrer|camí|passeig|av\.)\s/i;
const POSTAL = /\b(?:0[1-9]|[1-4]\d|5[0-2])\d{3}\b/;
const LEGAL_FORM = /\b(s\.?\s?l\.?\s?p\.?|s\.?\s?l\.?\s?u\.?|s\.?\s?l\.?\s?n\.?\s?e\.?|s\.?\s?l\.?|s\.?\s?a\.?\s?u\.?|s\.?\s?a\.?|s\.?\s?c\.?\s?p\.?|s\.?\s?c\.?|c\.?\s?b\.?|s\.?\s?coop\.?(?:\s?galega|\s?andaluza)?|sociedad (?:limitada|an[oó]nima|cooperativa)|slu|sl|sa)(?=$|[\s,.;)])/i;
const NOT_NAME = /^(?:factura|albar[aá]n|pedido|presupuesto|nota de entrega|ticket|factura simplificada|original|copia|duplicado|p[aá]gina|tel[eé]fono|tel|telf|fax|m[oó]vil|email|e-mail|web|www|fecha|n[ºo°]|n[uú]mero|cliente|proveedor|datos|total|base|iva|importe|descripci[oó]n|concepto|cantidad|precio|forma de pago|iban|vencimiento|domicilio|direcci[oó]n|c[oó]digo|gracias|firma|observaciones)\b/i;
const CONTACT = /@|www\.|https?:|\.(?:com|es|net|org|gal|cat|eus)\b|(?:\+34\s?)?\b[6-9]\d{2}[\s.]?\d{2,3}[\s.]?\d{2,3}[\s.]?\d{0,3}\b/i;

// ¿Lo emite la propia empresa (venta) o lo recibe (compra)?
function detectDirection(rows, labelZones, ownZones, nifs, own) {
  if (!ownZones.length) return 'recibido';
  const overlaps = (a, b) => a.r0 <= b.r1 && b.r0 <= a.r1 && a.x0 < b.x1 && b.x0 < a.x1;
  // La empresa aparece dentro del bloque "Cliente / Facturar a / Entregar a": es una compra
  if (ownZones.some(o => labelZones.some(l => overlaps(o, l)))) return 'recibido';
  // Hay un bloque de cliente que no es la empresa: es una venta
  if (labelZones.length) return 'emitido';
  // Sin etiquetas: quien encabeza el documento es el emisor
  const issuer = findSupplier(rows, [], nifs, { nif: null, name: null });
  const key = canon(own.name || '').replace(/\b(s l u?|s a u?|sl|sa|slu)\b/g, '').trim();
  if (issuer.proveedor && key.length >= 3 && canon(issuer.proveedor).includes(key)) return 'emitido';
  if (own.nif && issuer.nif && issuer.nif.value === own.nif) return 'emitido';
  return 'recibido';
}

// Zonas que pertenecen al cliente (etiqueta "Cliente", "Facturar a"... o el nombre/NIF propio)
function clientZones(rows, own) {
  const zones = [];
  const ownName = own.name ? canon(own.name).replace(/\b(s l u?|s a u?|sl|sa|slu)\b/g, '').trim() : null;
  const addZone = (ri, seg, withLabelRow, kind) => {
    const z = { r0: ri, r1: ri, x0: seg.x0 - 25, x1: seg.x1 + 25, kind };
    for (let k = ri + (withLabelRow ? 1 : 0); k < Math.min(rows.length, ri + 7); k++) {
      const prev = rows[k - 1];
      if (k > ri && prev && rows[k].y - prev.y > Math.max(prev.h, rows[k].h) * 2.6) break;
      const s = rows[k].segs.find(s => Math.abs(s.x0 - seg.x0) < 60 || (overlapX(s, z) > 0 && s.x0 >= z.x0 - 10));
      if (!s) { if (k > ri + 1) break; else continue; }
      if (k > ri && labelOf(s.text) && !['nif'].includes(labelOf(s.text).key) && !/^(?:nif|cif)/i.test(s.text)) break;
      z.r1 = k; z.x1 = Math.max(z.x1, s.x1 + 10);
    }
    zones.push(z);
  };
  rows.forEach((row, ri) => row.segs.forEach(seg => {
    const l = labelOf(seg.text) || splitInline(seg.text);
    if (l && l.key === 'cliente') addZone(ri, seg, !l.value, 'label');
    else if (ownName && ownName.length >= 3 && canon(seg.text).includes(ownName)) addZone(Math.max(0, ri), seg, false, 'own');
    else if (own.nif && seg.text.toUpperCase().replace(/[\s.\-]/g, '').includes(own.nif)) {
      // NIF propio: la zona empieza unas filas más arriba (nombre y dirección del cliente)
      let top = ri;
      for (let k = ri - 1; k >= Math.max(0, ri - 4); k--) if (rows[k].segs.some(s => Math.abs(s.x0 - seg.x0) < 60)) top = k; else break;
      const s0 = rows[top].segs.find(s => Math.abs(s.x0 - seg.x0) < 60) || seg;
      addZone(top, s0, false, 'own');
      zones[zones.length - 1].r1 = Math.max(zones[zones.length - 1].r1, ri);
    }
  }));
  return zones;
}
const inZones = (zones, ri, seg) => zones.some(z => ri >= z.r0 && ri <= z.r1 && seg.x0 >= z.x0 - 5 && seg.x1 <= z.x1 + 40);

function cleanName(t) {
  let s = t.replace(/\s*[-–·|]\s*(?:c\.?i\.?f|n\.?i\.?f)\.?.*$/i, '');
  s = s.replace(/^(?:proveedor|emisor|raz[oó]n social|de|vendedor)\s*[:\-]\s*/i, '');
  const lf = LEGAL_FORM.exec(s);
  if (lf) s = s.slice(0, lf.index + lf[0].length);
  s = s.replace(/\s*[,·|-]\s*$/, '').trim();
  return s;
}

function findSupplier(rows, zones, nifs, own, { prefer = [] } = {}) {
  // NIF del proveedor: el primero válido que no sea el propio ni esté en el bloque del cliente
  const ownNif = own.nif;
  const nifInfo = nifs.map(n => {
    let loc = null;
    for (let ri = 0; ri < rows.length && !loc; ri++) for (const s of rows[ri].segs) {
      const flat = s.text.toUpperCase().replace(/[\s.\-]/g, '');
      if (flat.includes(n.value) || (n.ocrFixedFrom && flat.includes(n.ocrFixedFrom))) { loc = { ri, seg: s }; break; }
    }
    return { ...n, loc, own: n.value === ownNif || (loc && inZones(zones, loc.ri, loc.seg)) };
  });
  const cands = nifInfo.filter(n => !n.own);
  const preferred = cands.filter(n => n.loc && inZones(prefer, n.loc.ri, n.loc.seg));
  const nif = preferred.find(n => n.valid) || cands.find(n => n.valid) || preferred[0] || cands[0] || null;

  // Nombre: se puntúan los bloques de la parte superior
  const hs = rows.flatMap(r => r.segs.map(s => s.h));
  const medH = median(hs) || 10;
  const limit = Math.max(8, Math.ceil(rows.length * 0.45));
  let best = null;
  const consider = (ri, seg, bonus = 0) => {
    const raw = seg.text.trim();
    const t = cleanName(raw);
    const letters = (t.match(/[a-záéíóúñü]/gi) || []).length;
    if (letters < 3 || t.length > 70) return;
    if (inZones(zones, ri, seg)) return;
    if (NOT_NAME.test(norm(t)) || labelOf(t) || splitInline(raw)?.value) return;
    if (ADDRESS.test(t + ' ') || (POSTAL.test(t) && /\d/.test(t)) || CONTACT.test(t) || datesIn(t).length) return;
    if (amountsIn(t).length) return;
    if (own.name && canon(t).includes(canon(own.name).split(' ')[0]) && canon(own.name).length > 3) return;
    let score = bonus;
    if (prefer.length && inZones(prefer, ri, seg)) score += 8;
    if (LEGAL_FORM.test(raw)) score += 5;
    score += Math.max(0, Math.min(6, (seg.h / medH - 1) * 4));
    score += (1 - ri / rows.length) * 2.5;
    if (/\d/.test(t)) score -= 2;
    if (/^[A-ZÁÉÍÓÚÑ0-9 .,&'-]+$/.test(t) && letters > 5) score += 0.5;
    if (!best || score > best.score) best = { value: t, score };
  };
  // Bloque de datos del proveedor: filas en la misma columna justo encima de su NIF
  if (nif?.loc) {
    const { ri, seg } = nif.loc;
    for (let k = ri; k >= Math.max(0, ri - 6); k--) {
      const s = rows[k].segs.find(x => overlapX(x, { x0: seg.x0 - 40, x1: seg.x1 + 200 }) > 0 && Math.abs(x.x0 - seg.x0) < 250 || (x.x1 > seg.x1 - 60 && Math.abs(x.x1 - seg.x1) < 60));
      if (s) consider(k, s, 3 + (ri - k) * 0.2);
    }
  }
  rows.slice(0, limit).forEach((r, ri) => r.segs.forEach(s => consider(ri, s)));
  // Etiqueta explícita "Proveedor: X"
  for (const [ri, r] of rows.entries()) for (const s of r.segs) {
    const l = splitInline(s.text);
    if (l?.key === 'proveedor' && l.value && !CLIENT_LABEL.test(canon(l.value))) consider(ri, { ...s, text: l.value }, 8);
  }
  // Pie de página: "Empresa S.L. · Inscrita en el Registro Mercantil…"
  if (!best || best.score < 3) for (const [ri, r] of rows.entries()) for (const s of r.segs) {
    if (/registro mercantil|inscrita/i.test(s.text) && LEGAL_FORM.test(s.text)) consider(ri, { ...s, text: s.text.split(/[·|,]/)[0] }, 2);
  }
  // Logo abreviado ("Almacenes Eléctricos") y razón social completa en el pie: se usa la completa
  if (best && !LEGAL_FORM.test(best.value)) {
    const key = canon(best.value);
    for (const [ri, r] of rows.entries()) for (const s of r.segs) {
      if (inZones(zones, ri, s)) continue;
      for (const part of s.text.split(/\s[·|•\-–]\s/)) {
        const full = cleanName(part);
        if (LEGAL_FORM.test(full) && canon(full).startsWith(key) && full.length > best.value.length && full.length < 80) { best.value = full; break; }
      }
    }
  }
  return { proveedor: best ? best.value : null, nif, nifInfo };
}

// ================================================================ campos

function pickNumber(pairs, rows, docType, nifs) {
  const typeWord = { factura: /factura|fra|invoice|ticket/, rectificativa: /factura|fra|rectificativa|abono/, albaran: /albaran|entrega|nota/, pedido: /pedido/, presupuesto: /presupuesto|oferta/ }[docType];
  const isGood = t => t && /\d/.test(t) && t.length >= 2 && t.length <= 25 && !/^n[º°o9s0*]$/i.test(t) &&!/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(t) && !nifs.some(n => n.value === t.toUpperCase().replace(/[\s.\-]/g, '')) && !/^\d{1,2}$/.test(t) && !/%$/.test(t);
  const cands = [];
  for (const p of pairs.filter(p => p.key === 'numero')) {
    const other = /factura|fra|albaran|pedido|presupuesto|oferta|nota|ticket|entrega/.test(p.c) && !typeWord.test(p.c);
    const tok = p.value.split(/\s+/).map(t => t.replace(/[.,;:]+$/, '')).find(isGood);
    if (!tok) continue;
    let pr = typeWord.test(p.c) ? 3 : 2;
    if (other) pr = 0.5;
    if (p.how === 'inline' && /^(factura|albaran|pedido|presupuesto)$/.test(p.c)) pr += 0.5; // título "Factura 2024-00087"
    cands.push({ v: tok, pr: pr - p.row * 0.002 });
  }
  cands.sort((a, b) => b.pr - a.pr);
  return cands[0]?.v || null;
}

function pickDates(pairs, rows) {
  const firstDate = key => {
    for (const p of pairs.filter(p => p.key === key)) { const d = datesIn(p.value); if (d.length) return d[0]; }
    return null;
  };
  let fecha = firstDate('fecha');
  let vencimiento = firstDate('vencimiento');
  if (!fecha) {
    // Primera fecha del documento que no sea el vencimiento, un cobro o un periodo
    scan: for (const r of rows) for (const s of r.segs) {
      const n = norm(s.text);
      if (/vencim|vto|periodo|desde|hasta|nacimiento|caducidad|cobro|cargo|pagar antes|vence/.test(n)) continue;
      const d = datesIn(s.text);
      if (d.length) { fecha = d[0]; break scan; }
    }
  }
  if (!vencimiento) {
    // "Cobro … el 03/04/2025", "Se cargará en cuenta el …"
    scan2: for (const r of rows) for (const s of r.segs) {
      if (!/cobro|cargo|cargara|pagar antes|vence|a pagar el|pago el/.test(norm(s.text))) continue;
      const d = datesIn(s.text).filter(x => x !== fecha);
      if (d.length) { vencimiento = d[d.length - 1]; break scan2; }
    }
  }
  return { fecha, vencimiento };
}

// Filas que pertenecen a la tabla de líneas (para no confundir productos con otros datos)
function findLines(rows) {
  // Tipo de columna por palabras clave (las cabeceras cambian mucho de un proveedor a otro)
  const colKind = t => {
    const c = canon(t).replace(/ €$/, '').trim();
    if (!c || c.length > 30) return null;
    if (/^(?:ref|referencia|codigo|cod|art|sku|ref art|num|codigo articulo|cod art|ean|lote)$/.test(c)) return 'ref';
    if (/descripcion|concepto|articulo|producto|detalle|denominacion|description|^item|servicio|material|designacion|^trabajo/.test(c)) return 'desc';
    if (/^(?:dto|descuento|% dto|dcto|dto %|desc|% desc|bonif)/.test(c)) return 'dto';
    if (/precio|€ ?\/|\/ ?(?:ud|u|h|hora|kg|l|m)$|^p ?u|^pvp|unitario|tarifa|unit price|^€$|^eur ?\/|€\/ud/.test(c)) return 'price';
    if (/importe|^total|subtotal|^neto|amount|^base$/.test(c)) return 'amount';
    if (/^(?:iva|% iva|iva %|t iva|tipo iva|% igic)$/.test(c)) return 'iva';
    if (/cant|^uds?\b|unidades|^unid|qty|cajas|^kg|kilos|^horas?$|^h$|bultos|^n ?uds|servid|^peso|^litros|^m2?$|\/uds|^num uds/.test(c)) return 'qty';
    return null;
  };
  let hi = -1, cols = null;
  for (let i = 0; i < rows.length; i++) {
    const kinds = rows[i].segs.map(s => ({ s, k: colKind(s.text) }));
    // Cabecera con varias columnas en un solo bloque ("Cant. Descripción Importe")
    if (kinds.filter(x => x.k).length < 2 && rows[i].segs.length <= 2) {
      const words = rows[i].segs.flatMap(s => s.text.split(/\s+/));
      if (words.filter(w => colKind(w)).length >= 3 && words.some(w => colKind(w) === 'desc')) { hi = i; cols = null; break; }
    }
    if (kinds.filter(x => x.k).length >= 2 && kinds.some(x => x.k === 'desc') && kinds.some(x => ['qty', 'amount', 'price'].includes(x.k))) {
      hi = i; cols = kinds.filter(x => x.k).map(x => ({ k: x.k, x0: x.s.x0, x1: x.s.x1, c: (x.s.x0 + x.s.x1) / 2 })); break;
    }
  }
  if (hi < 0) return { lines: [], start: -1, end: -1 };
  const STOP = /^(?:base imponible|subtotal|sub total|total|suma|forma de pago|observaciones|firma|recibi|recibido|conforme|bultos|importe total|base|iva|neto|notas?|condiciones|vencimiento|iban|portes? (?:pagados|debidos))\b/;
  const out = [];
  let end = hi;
  for (let i = hi + 1; i < rows.length && out.length < 80; i++) {
    const row = rows[i];
    const n = canon(row.segs.map(s => s.text).join(' '));
    if (STOP.test(n) || row.segs.some(s => { const l = labelOf(s.text); return l && ['base', 'total', 'iva', 'forma_pago', 'recargo', 'retencion'].includes(l.key); })) break;
    if (i > hi + 1 && row.y - rows[i - 1].y > Math.max(row.h, rows[i - 1].h) * 5) break;
    end = i;
    let line;
    if (cols) {
      const cells = {};
      for (const s of row.segs) {
        let best = null, bestScore = -Infinity;
        for (const c of cols) {
          const ov = overlapX(s, c);
          const score = ov > 0 ? ov : -Math.abs((s.x0 + s.x1) / 2 - c.c);
          if (score > bestScore) { bestScore = score; best = c; }
        }
        // Un bloque ancho que empieza en la columna de descripción es texto aunque roce otra columna
        const target = cols.find(c => c.k === 'desc' && s.x0 >= c.x0 - 20 && s.x0 < c.x1 + 60 && !/^[\d.,€%\s-]+$/.test(s.text)) || best;
        (cells[target.k] ||= []).push({ s, score: bestScore });
      }
      // En una columna numérica vale el bloque mejor alineado; lo demás vuelve a la descripción
      // (p. ej. el "2024" de "Servicio agosto 2024" que el OCR separa del texto)
      for (const k of ['qty', 'price', 'amount', 'dto', 'iva']) {
        const list = cells[k];
        if (!list || list.length < 2) continue;
        list.sort((a, b) => b.score - a.score);
        const keep = list.filter(x => /^[\d.,€%\s-]+$/.test(x.s.text)).slice(0, 1);
        if (!keep.length) continue;
        for (const x of list) if (x !== keep[0] && cells.desc && x.s.x1 < keep[0].s.x0) cells.desc.push(x);
        cells[k] = keep;
      }
      if (cells.desc) cells.desc.sort((a, b) => a.s.x0 - b.s.x0);
      const num = k => cells[k] ? parseAmount(cells[k].map(x => x.s.text).join(' ').replace(/%/g, '')) : null;
      let desc = (cells.desc || []).map(x => x.s.text).join(' ').trim();
      if (cells.ref) cells.ref = cells.ref.map(x => x.s.text);
      if (!desc && cells.ref && !cols.some(c => c.k === 'desc')) desc = cells.ref.join(' ');
      line = { descripcion: desc, cantidad: num('qty'), precio: num('price'), importe: num('amount') };
      if (cells.dto) line.dto = num('dto');
      if (!/[a-z]{2}/i.test(desc) && line.cantidad === null && line.importe === null) continue;
      // Continuación de la descripción de la línea anterior
      if (desc && line.cantidad === null && line.importe === null && line.precio === null && out.length) { out[out.length - 1].descripcion += ' ' + desc; continue; }
      if (!desc) continue;
    } else {
      line = tokenLine(row.segs.map(s => s.text).join('   '));
      if (!line) continue;
    }
    fixLineNumbers(line);
    line.descripcion = line.descripcion.replace(/\s+/g, ' ').slice(0, 120);
    out.push(line);
  }
  return { lines: out, start: hi, end };
}

// Línea sin columnas conocidas: números al final -> [cantidad] [precio] importe
function tokenLine(text) {
  const tokens = text.replace(/€/g, ' ').split(/\s+/).filter(Boolean);
  let k = tokens.length;
  while (k > 0 && /^-?\d+(?:[.,]\d+)*%?$/.test(tokens[k - 1])) k--;
  const numTokens = tokens.slice(k).filter(t => !/%$/.test(t));
  const nums = numTokens.map(parseAmount).filter(v => v !== null);
  let descT = tokens.slice(0, k);
  // Código de referencia al principio ("1007 Tuerca…")
  if (descT.length > 1 && /^[A-Z]*\d{3,}[A-Z0-9\-]*$/i.test(descT[0])) descT = descT.slice(1);
  let desc = descT.join(' ');
  if (!nums.length || !/[a-z]{2}/i.test(desc)) return null;
  let cantidad = null, precio = null;
  if (nums.length >= 3) { cantidad = nums[0]; precio = nums[nums.length - 2]; }
  else if (nums.length === 2) { if (/^\d+$/.test(numTokens[0])) cantidad = nums[0]; else precio = nums[0]; }
  if (cantidad === null) {
    const unit = '(?:uds?\\.?|unid(?:ad(?:es)?)?\\.?|u\\.?|kg|g|l|cajas?|horas?|h)';
    const lead = desc.match(/^(\d+(?:[.,]\d+)?)\s+(?=\D)/);
    const tail = desc.match(new RegExp(`\\s(\\d+(?:[.,]\\d+)?)\\s*(${unit})$`, 'i'));
    if (lead) { cantidad = parseAmount(lead[1]); desc = desc.slice(lead[0].length); }
    else if (tail) { cantidad = parseAmount(tail[1]); desc = desc.slice(0, tail.index); }
  }
  return { descripcion: desc, cantidad, precio, importe: nums[nums.length - 1] };
}

// El OCR a veces pierde la coma decimal ("2,10" -> "210"): se corrige si la cuenta cuadra
function fixLineNumbers(l) {
  const { cantidad: q, precio: p, importe: i } = l;
  const f = 1 - (l.dto || 0) / 100;
  const ok = (q, p, i) => Math.abs(q * p * f - i) <= Math.max(0.02, Math.abs(i) * 0.002);
  if (q !== null && p !== null && i !== null && !ok(q, p, i)) {
    for (const [dq, dp, di] of [[1, 0.01, 1], [1, 1, 0.01], [1, 0.01, 0.01], [0.01, 1, 1], [1, 0.1, 1], [1, 1, 0.1]]) {
      if (ok(q * dq, p * dp, i * di)) { l.cantidad = round2(q * dq); l.precio = round2(p * dp); l.importe = round2(i * di); return; }
    }
    // Cantidad mal leída (7 por 2, 4 por 1): si importe / precio da un número entero, manda la cuenta
    const qq = i / p / f;
    if (p && Math.abs(qq - Math.round(qq)) < 0.005 && Math.round(qq) > 0 && Math.round(qq) < 100000) { l.cantidad = Math.round(qq); return; }
    // Si no, se confía en cantidad e importe y se recalcula el precio unitario
    if (q) l.precio = round2(i / q / f);
  }
  if (q !== null && p === null && i !== null && q) l.precio = round2(i / q / f);
  if (q === null && p !== null && i !== null && p) { const qq = i / p / f; if (Math.abs(qq - Math.round(qq)) < 0.01) l.cantidad = Math.round(qq); }
}

function pickTotals(pairs, rows, lineInfo) {
  const cand = { base: [], iva: [], total: [], recargo: [], retencion: [] };
  const rates = {};
  const ivaRows = [];
  for (const p of pairs) {
    if (p.row >= lineInfo.start && p.row <= lineInfo.end && lineInfo.start >= 0) continue; // dentro de la tabla de líneas
    if (!['base', 'iva', 'total', 'recargo', 'retencion', 'iva_tipo'].includes(p.key)) continue;
    if (p.key === 'iva_tipo') { const r = parseAmount(p.value.split('/')[0].replace('%', '')); if (r !== null && [0, 4, 5, 7, 10, 12, 21].includes(r)) rates.label = rates.label ?? r; continue; }
    const vals = amountsIn(p.value, { loose: p.how !== 'inline' });
    if (!vals.length) continue;
    const v = Math.abs(vals[vals.length - 1]);
    if (p.key === 'iva' && p.rate !== undefined) { ivaRows.push({ rate: p.rate, v, row: p.row }); continue; }
    let pr = 1;
    if (p.key === 'total' && /factura|a pagar|importe total|total importe|documento|albaran|pedido|presupuesto|iva incl|eur|€|liquido/.test(p.c)) pr = 3;
    // "Importe pagado" puede ser 0 o un pago parcial: solo sirve si no hay otro total
    if (p.key === 'total' && /pagado/.test(p.c)) pr = v > 0 ? 0.8 : 0.1;
    if (p.key === 'base' && /base imponible/.test(p.c)) pr = 2;
    cand[p.key].push({ v, pr, row: p.row, rate: p.rate });
  }
  // Tipo de IVA escrito en otras partes ("IVA 21%", "21% IVA")
  const ratesSeen = new Set(ivaRows.map(r => r.rate));
  if (!ratesSeen.size) {
    for (const r of rows) for (const s of r.segs) {
      const m = canon(s.text).match(/(?:iva|i v a)\s*\(?(\d{1,2}(?:[.,]\d{1,2})?)\s*%|(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*(?:de\s*)?iva/);
      if (m) { const v = parseAmount(m[1] || m[2]); if ([4, 5, 10, 21].includes(v)) ratesSeen.add(v); }
    }
    if (rates.label !== undefined) ratesSeen.add(rates.label);
  }
  const pick = (arr, { last = true } = {}) => {
    if (!arr.length) return null;
    const maxP = Math.max(...arr.map(a => a.pr));
    const top = arr.filter(a => a.pr === maxP);
    return last ? top[top.length - 1].v : top[0].v;
  };
  let base = pick(cand.base), total = pick(cand.total), recargo = pick(cand.recargo), retencion = pick(cand.retencion);
  let iva;
  // Varias filas "IVA x%": la cuota total es la suma de las distintas
  const uniq = [];
  for (const r of ivaRows) if (!uniq.some(u => u.rate === r.rate && Math.abs(u.v - r.v) < 0.005)) uniq.push(r);
  if (uniq.length) iva = round2(uniq.reduce((a, b) => a + b.v, 0));
  else iva = pick(cand.iva);
  const rateList = [...new Set([...uniq.map(u => u.rate), ...ratesSeen])];
  let iva_tipo = rateList.length === 1 ? rateList[0] : null;

  const sumLines = lineInfo.lines.length && lineInfo.lines.every(l => l.importe !== null) ? round2(lineInfo.lines.reduce((a, l) => a + l.importe, 0)) : null;
  const derived = [];
  const fits = (b, i, t) => b !== null && i !== null && t !== null && Math.abs(b + i + (recargo || 0) - (retencion || 0) - t) <= 0.05;

  // Si no cuadra, se prueban otras combinaciones con los importes leídos en la zona de totales
  if (!fits(base, iva, total) && (base !== null || total !== null)) {
    const all = [...new Set([...cand.base, ...cand.total, ...cand.iva, ...uniq].map(c => c.v).concat(sumLines !== null ? [sumLines] : []))];
    let found = null;
    for (const b of all) for (const t of all) {
      if (t <= b) continue;
      const i = round2(t - b - (recargo || 0) + (retencion || 0));
      const r = b ? i / b * 100 : 0;
      const rateOk = rateList.length ? rateList.some(x => Math.abs(b * x / 100 - i) <= 0.03) || (rateList.length > 1) : [4, 5, 10, 21].some(x => Math.abs(r - x) < 0.3);
      if (rateOk && (all.some(x => Math.abs(x - i) <= 0.02) || uniq.length > 1)) {
        const score = (Math.abs(b - (base ?? -1)) < 0.01) + (Math.abs(t - (total ?? -1)) < 0.01) + (sumLines !== null && Math.abs(b - sumLines) < 0.01);
        if (!found || score > found.score) found = { b, i, t, score };
      }
    }
    if (found) { base = found.b; iva = found.i; total = found.t; }
  }
  if (base === null && sumLines !== null && (total === null || sumLines < total)) { base = sumLines; derived.push('base'); }
  if (base !== null && iva === null && iva_tipo !== null) { iva = round2(base * iva_tipo / 100); derived.push('iva'); }
  if (base !== null && iva !== null && total === null) { total = round2(base + iva + (recargo || 0) - (retencion || 0)); derived.push('total'); }
  if (total !== null && base === null && iva !== null) { base = round2(total - iva - (recargo || 0) + (retencion || 0)); derived.push('base'); }
  if (total !== null && base === null && iva === null && iva_tipo !== null) { base = round2(total / (1 + iva_tipo / 100)); iva = round2(total - base); derived.push('base', 'iva'); }
  if (iva_tipo === null && base && iva && rateList.length <= 1) {
    const r = iva / base * 100;
    const near = [4, 5, 10, 21].find(x => Math.abs(r - x) < 0.3);
    if (near) { iva_tipo = near; derived.push('iva_tipo'); }
  }
  return { base, iva, iva_tipo, total, recargo, retencion, derived, sumLines, rates: rateList };
}

function pickPayment(pairs, rows, lineInfo) {
  let forma = null;
  for (const p of pairs.filter(p => p.key === 'forma_pago')) {
    const v = p.value.replace(/^[:\-\s]+/, '').split(/[.;]\s|\s+(?:en|a la cuenta|al|el|en la cuenta|cuenta)\s+(?=ES\d|\d|n[ºo°]|cuenta)|\s+ES\d{2}\b|\s+iban\b/i)[0].trim();
    if (v && /[a-z]{3}/i.test(v) && !amountsIn(v).length) { forma = v.slice(0, 60); break; }
  }
  if (!forma) {
    const KW = /\b(transferencia(?: bancaria)?|domiciliaci[oó]n(?: bancaria)?|recibo(?: domiciliado)?|contado|efectivo|tarjeta(?: de (?:cr[eé]dito|d[eé]bito))?|bizum|confirming|pagar[eé](?: \d+ d[ií]as)?|cheque|paypal|contra reembolso|reembolso)\b/i;
    for (const [ri, r] of rows.entries()) {
      if (ri >= lineInfo.start && ri <= lineInfo.end && lineInfo.start >= 0) continue;
      for (const s of r.segs) {
        const m = s.text.match(KW);
        if (m && (s.text.length < 50 || /pago|pagad|cobro|cargo/i.test(s.text))) { forma = m[1]; break; }
      }
      if (forma) break;
    }
  }
  return forma ? forma.charAt(0).toUpperCase() + forma.slice(1) : null;
}

// ================================================================ extracción completa

function extractFields(text, opts = {}) {
  const rows = opts.rows && opts.rows.length ? opts.rows : textToRows(text);
  const own = {
    nif: opts.ownNif ? opts.ownNif.toUpperCase().replace(/[\s\-.]/g, '').replace(/^ES/, '') : null,
    name: opts.ownName || null,
  };
  const flatText = rowsToText(rows);
  const doc_type = detectType(rows);
  const pairs = findPairs(rows);
  const nifs = nifsInText(flatText);
  const allZones = clientZones(rows, own);
  const labelZones = allZones.filter(z => z.kind === 'label');
  const ownZones = allZones.filter(z => z.kind === 'own');
  const direction = ['recibido', 'emitido'].includes(opts.direction) ? opts.direction : detectDirection(rows, labelZones, ownZones, nifs, own);
  // Recibido: el tercero es el emisor (se excluye todo lo del cliente).
  // Emitido: el tercero es el cliente (se excluye lo propio y se prefiere el bloque "Cliente").
  const sup = direction === 'emitido'
    ? findSupplier(rows, ownZones, nifs, own, { prefer: labelZones })
    : findSupplier(rows, allZones, nifs, own);
  const lineInfo = findLines(rows);
  const totals = pickTotals(pairs, rows, lineInfo);
  const dates = pickDates(pairs, rows);
  const iban = findIban(flatText);

  const fields = {
    proveedor: sup.proveedor,
    nif: sup.nif ? sup.nif.value : null,
    numero: pickNumber(pairs, rows, doc_type, nifs),
    fecha: dates.fecha,
    vencimiento: dates.vencimiento,
    base: totals.base,
    iva_tipo: totals.iva_tipo,
    iva: totals.iva,
    recargo: totals.recargo,
    retencion: totals.retencion,
    total: totals.total,
    forma_pago: pickPayment(pairs, rows, lineInfo),
    iban: iban ? iban.value : null,
  };
  // Albarán/pedido sin precios: no inventar importes
  if (!isInvoice(doc_type) && fields.total === null && !lineInfo.lines.some(l => l.importe !== null)) fields.base = fields.iva = fields.iva_tipo = null;

  return finalize({ doc_type, direction, fields, lines: lineInfo.lines, derived: totals.derived, all_nifs: sup.nifInfo.map(({ loc, ...n }) => n), ocrFixedFrom: sup.nif?.ocrFixedFrom });
}

const isInvoice = t => t === 'factura' || t === 'rectificativa';

// Comprobaciones y puntuación (también se usan para el resultado combinado con IA)
function finalize(r) {
  const { fields, doc_type } = r;
  const checks = [];
  if (r.ocrFixedFrom) checks.push({ id: 'nif_ocr', ok: true, warn: true, msg: `NIF corregido automáticamente: el OCR leyó "${r.ocrFixedFrom}"` });
  if (fields.nif) checks.push({ id: 'nif', ok: validNif(fields.nif), msg: validNif(fields.nif) ? 'NIF/CIF con dígito de control válido' : 'NIF/CIF con dígito de control incorrecto (posible error de lectura)' });
  else checks.push({ id: 'nif', ok: false, msg: `No se ha encontrado NIF/CIF del ${r.direction === 'emitido' ? 'cliente' : 'proveedor'}` });
  const b = fields.base, i = fields.iva, t = fields.total;
  if (b !== null && i !== null && t !== null) {
    const calc = b + i + (fields.recargo || 0) - (fields.retencion || 0);
    const diff = Math.abs(calc - t);
    const extra = [fields.recargo ? 'recargo' : '', fields.retencion ? 'retención' : ''].filter(Boolean).join(' y ');
    checks.push({ id: 'cuadre', ok: diff <= 0.05, msg: diff <= 0.05 ? `Base + IVA${extra ? ' con ' + extra : ''} = Total` : `Base + IVA${extra ? ' con ' + extra : ''} no cuadra con el total (diferencia ${diff.toFixed(2)} €)` });
  } else if (isInvoice(doc_type)) checks.push({ id: 'cuadre', ok: false, msg: 'Faltan importes para comprobar el cuadre' });
  if (b !== null && i !== null && fields.iva_tipo !== null && fields.iva_tipo !== undefined && Math.abs(b * fields.iva_tipo / 100 - i) > 0.05 + b * 0.001) {
    checks.push({ id: 'tipo_iva', ok: false, warn: true, msg: `La cuota de IVA no corresponde al ${fields.iva_tipo}% de la base (puede haber varios tipos)` });
  }
  const priced = (r.lines || []).filter(l => l.importe !== null && l.importe !== undefined);
  if (priced.length && b !== null) {
    const sum = round2(priced.reduce((a, l) => a + l.importe, 0));
    if (Math.abs(sum - b) <= 0.05) checks.push({ id: 'lineas', ok: true, msg: `La suma de las ${priced.length} líneas coincide con la base` });
    else if (t !== null && Math.abs(sum - t) <= 0.05) checks.push({ id: 'lineas', ok: true, msg: `La suma de las ${priced.length} líneas coincide con el total (precios con IVA incluido)` });
    else if (priced.length === r.lines.length) checks.push({ id: 'lineas', ok: false, warn: true, msg: `La suma de las líneas (${sum.toFixed(2)} €) no coincide con la base (descuentos, portes o líneas no leídas)` });
  }
  if (fields.iban) checks.push({ id: 'iban', ok: validIban(fields.iban), msg: validIban(fields.iban) ? 'IBAN con dígitos de control válidos' : 'IBAN con dígitos de control incorrectos (revísalo)' });
  if (r.derived?.length) checks.push({ id: 'derivados', ok: true, warn: true, msg: `Calculado a partir de otros campos: ${[...new Set(r.derived)].join(', ')}` });
  checks.push({ id: 'fecha', ok: !!fields.fecha, msg: fields.fecha ? 'Fecha detectada' : 'No se ha encontrado la fecha' });
  if (fields.fecha && fields.vencimiento && dateKey(fields.vencimiento) < dateKey(fields.fecha)) checks.push({ id: 'vencimiento', ok: false, warn: true, msg: 'El vencimiento es anterior a la fecha del documento' });
  checks.push({ id: 'numero', ok: !!fields.numero, msg: fields.numero ? 'Número de documento detectado' : 'No se ha encontrado el número de documento' });
  if (r.extraChecks) checks.push(...r.extraChecks);

  const priceDoc = isInvoice(doc_type) || (t !== null && t !== undefined);
  const keys = priceDoc ? ['proveedor', 'nif', 'numero', 'fecha', 'base', 'iva', 'total'] : ['proveedor', 'nif', 'numero', 'fecha'];
  const found = keys.filter(k => !isEmpty(fields[k])).length;
  const coverage = found / keys.length;
  const okChecks = checks.filter(c => !c.warn);
  const checkScore = okChecks.length ? okChecks.filter(c => c.ok).length / okChecks.length : 0;
  const { ocrFixedFrom, extraChecks, ...rest } = r;
  return { ...rest, checks, score: Math.round((coverage * 0.6 + checkScore * 0.4) * 1000) / 10 };
}

// Rellena con la lectura por zonas los campos clave que faltan tras el OCR de la página
async function recheckZones(t, local) {
  const f = local.fields;
  const needTotals = isInvoice(local.doc_type) && (f.total === null || f.base === null || f.iva === null);
  const needName = !f.proveedor || !LEGAL_FORM.test(f.proveedor);
  if (f.numero && f.fecha && !needTotals && !needName) return local;
  const zones = [];
  if (!f.numero || !f.fecha) zones.push([0, 0, 0.55, 0.4], [0.4, 0, 0.6, 0.4]);
  if (needTotals) zones.push([0.3, 0.3, 0.7, 0.6]);
  if (needName) zones.push([0, 0.86, 1, 0.14]);
  const zoneRows = await ocrZones(t.image, zones);
  const filled = [];
  if (needName && f.proveedor) {
    const key = canon(f.proveedor);
    for (const rows of zoneRows) for (const r of rows) for (const sg of r.segs) for (const part of sg.text.split(/\s[·|•\-–]\s/)) {
      const full = cleanName(part);
      if (LEGAL_FORM.test(full) && canon(full).startsWith(key) && full.length > f.proveedor.length && full.length < 80) { f.proveedor = full; filled.push('proveedor'); }
    }
  }
  const nifs = nifsInText(t.text);
  for (const rows of zoneRows) {
    const pairs = findPairs(rows);
    if (!f.numero) { const v = pickNumber(pairs, rows, local.doc_type, nifs); if (v) { f.numero = v; filled.push('número'); } }
    if (!f.fecha || !f.vencimiento) {
      const d = pickDates(pairs.filter(p => p.key === 'fecha' || p.key === 'vencimiento'), []);
      if (!f.fecha && d.fecha) { f.fecha = d.fecha; filled.push('fecha'); }
      if (!f.vencimiento && d.vencimiento) f.vencimiento = d.vencimiento;
    }
    if (needTotals) {
      const tt = pickTotals(pairs, rows, { lines: local.lines || [], start: -1, end: -1 });
      if (tt.total !== null && tt.base !== null && tt.iva !== null && Math.abs(tt.base + tt.iva + (tt.recargo || 0) - (tt.retencion || 0) - tt.total) <= 0.05) {
        Object.assign(f, { base: tt.base, iva: tt.iva, total: tt.total, iva_tipo: f.iva_tipo ?? tt.iva_tipo, recargo: f.recargo ?? tt.recargo, retencion: f.retencion ?? tt.retencion });
        filled.push('importes');
      }
    }
  }
  if (!filled.length) return local;
  const { checks, score, ...rest } = local;
  return finalize({ ...rest, derived: local.derived || [], extraChecks: [...checks.filter(c => c.id === 'nif_ocr'), { id: 'zonas', ok: true, warn: true, msg: `Segunda lectura de zonas: ${[...new Set(filled)].join(', ')}` }] });
}

async function analyze(buffer, { mime, filename, ownNif, ownName, ai, direction } = {}) {
  const t = await getLayout(buffer, mime, filename);
  let local = extractFields(t.text, { rows: t.rows, ownNif, ownName, direction });
  if (t.image) local = await recheckZones(t, local);
  const base = { ...local, raw_text: t.text, ocr_confidence: t.confidence, method: t.method, engine: 'local' };
  const aiMod = require('./ai');
  if (ai === false || !aiMod.isEnabled()) return base;
  try {
    const r = await aiMod.extractWithAi(buffer, { mime, filename, text: t.text, ownNif, ownName, direction });
    if (['recibido', 'emitido'].includes(direction)) r.direction = direction;
    return { ...mergeAi(local, r, { ownNif, rawText: t.text, method: t.method }), raw_text: t.text, ocr_confidence: t.confidence, method: t.method, engine: 'ia', ai_model: r.model, ai_ms: r.ms };
  } catch (e) {
    if (!process.env.GESTY_QUIET) console.error('Lectura con IA no disponible:', e.message);
    base.checks = [{ id: 'ia', ok: true, warn: true, msg: 'Lectura con IA no disponible (' + String(e.message).slice(0, 120) + '). Se ha usado la lectura local.' }, ...base.checks];
    return base;
  }
}

// Combina la lectura con IA y la local: manda la IA, la local rellena huecos y, si ambas
// discrepan en un NIF o IBAN, gana el que supera la validación de dígitos de control.
function mergeAi(local, ai, { ownNif, rawText, method } = {}) {
  const fields = { ...local.fields };
  const extraChecks = [];
  const disagreements = [];
  const flat = v => String(v ?? '').toUpperCase().replace(/[\s.\-\/]/g, '');
  const rawFlat = method === 'pdf-texto' ? flat(rawText) : null;
  const MONEY = ['base', 'iva', 'iva_tipo', 'total', 'recargo', 'retencion'];
  const fits = f => f.base !== null && f.iva !== null && f.total !== null && Math.abs(f.base + f.iva + (f.recargo || 0) - (f.retencion || 0) - f.total) <= 0.05;
  // Importes: si los de la IA no cuadran y los locales sí, se quedan los locales
  const keepLocalMoney = !fits(ai.fields) && fits(local.fields);
  for (const k of Object.keys(ai.fields)) {
    const a = ai.fields[k], l = local.fields[k];
    if (isEmpty(a)) continue;
    if (keepLocalMoney && MONEY.includes(k)) continue;
    if (k === 'nif' && !validNif(a) && l && validNif(l)) continue;
    if (k === 'iban' && !validIban(a) && l && validIban(l)) continue;
    // PDF con texto: un número o NIF que no aparece en el propio PDF no se acepta si el local sí aparece
    if (rawFlat && ['numero', 'nif'].includes(k) && !rawFlat.includes(flat(a)) && l && rawFlat.includes(flat(l))) continue;
    if (!isEmpty(l) && String(a) !== String(l) && !(typeof a === 'number' && Math.abs(a - l) < 0.011)) disagreements.push(k);
    fields[k] = a;
  }
  if (ownNif && fields.nif && fields.nif.toUpperCase() === ownNif.toUpperCase().replace(/^ES/, '')) fields.nif = local.fields.nif;
  if (disagreements.length) extraChecks.push({ id: 'ia_local', ok: true, warn: true, msg: `La lectura con IA corrige a la local en: ${disagreements.join(', ')}` });
  return finalize({
    doc_type: ai.doc_type || local.doc_type,
    direction: ai.direction || local.direction,
    category: ai.category || null,
    fields,
    lines: ai.lines?.length ? ai.lines : local.lines,
    derived: [],
    all_nifs: local.all_nifs,
    extraChecks,
  });
}

module.exports = { analyze, extractFields, parseAmount, validNif, validIban, datesIn, finalize };
