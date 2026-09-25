'use strict';
/*
 * Lectura de documentos con IA (Claude, de Anthropic).
 * Se activa desde el panel de administrador (Lectura con IA) o con la variable de entorno
 * ANTHROPIC_API_KEY. El documento original (PDF o imagen) se envía a la API de Anthropic, que
 * devuelve los datos en un formato fijo; después pasan por las mismas comprobaciones que la
 * lectura local (NIF, IBAN, cuadre de importes). Si la IA falla, se usa la lectura local.
 */
const path = require('node:path');
// El SDK se carga al usarlo: si faltara, Gesty arranca igual y solo se desactiva la IA
let AnthropicMod;
function sdk() {
  if (AnthropicMod === undefined) { try { AnthropicMod = require('@anthropic-ai/sdk'); } catch { AnthropicMod = null; } }
  if (!AnthropicMod) throw new Error('falta la librería de la IA; ejecuta "npm install"');
  return AnthropicMod;
}
const { getSetting } = require('./db');

const { CATEGORIES } = require('./accounting');

const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — máxima precisión (recomendado)', approxEur: 0.04 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — equilibrado', approxEur: 0.015 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — el más económico', approxEur: 0.006 },
];
const DEFAULT_MODEL = 'claude-opus-5';

function config() {
  const dbKey = getSetting('ai_api_key');
  const apiKey = dbKey || process.env.ANTHROPIC_API_KEY || null;
  const model = getSetting('ai_model') || process.env.GESTY_AI_MODEL || DEFAULT_MODEL;
  const enabled = getSetting('ai_enabled', '1') === '1' && !!apiKey;
  return { apiKey, model, enabled, source: dbKey ? 'panel' : apiKey ? 'entorno' : null };
}
const isEnabled = () => config().enabled;

let cached = { key: null, client: null };
function getClient(apiKey) {
  if (cached.key !== apiKey) cached = { key: apiKey, client: new (sdk())({ apiKey, timeout: 120_000, maxRetries: 2 }) };
  return cached.client;
}

// ---------------------------------------------------------------- petición

const nullable = t => ({ anyOf: [{ type: t }, { type: 'null' }] });
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'direccion', 'categoria', 'proveedor', 'nif', 'numero', 'fecha', 'vencimiento', 'base', 'iva_tipo', 'iva', 'recargo', 'retencion', 'total', 'forma_pago', 'iban', 'lineas'],
  properties: {
    doc_type: { type: 'string', enum: ['factura', 'rectificativa', 'albaran', 'pedido', 'presupuesto'] },
    direccion: { type: 'string', enum: ['recibido', 'emitido'] },
    categoria: { type: 'string', enum: [...CATEGORIES.gasto, ...CATEGORIES.ingreso].map(c => c[0]) },
    proveedor: nullable('string'),
    nif: nullable('string'),
    numero: nullable('string'),
    fecha: nullable('string'),
    vencimiento: nullable('string'),
    base: nullable('number'),
    iva_tipo: nullable('number'),
    iva: nullable('number'),
    recargo: nullable('number'),
    retencion: nullable('number'),
    total: nullable('number'),
    forma_pago: nullable('string'),
    iban: nullable('string'),
    lineas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['descripcion', 'cantidad', 'precio', 'importe'],
        properties: { descripcion: { type: 'string' }, cantidad: nullable('number'), precio: nullable('number'), importe: nullable('number') },
      },
    },
  },
};

function systemPrompt(ownName, ownNif, direction) {
  const own = ownName ? `"${ownName}"${ownNif ? ` (NIF ${ownNif})` : ''}` : 'la empresa usuaria';
  return `Extraes datos de documentos comerciales españoles (facturas, facturas rectificativas, facturas simplificadas o tickets, albaranes, notas de entrega, pedidos y presupuestos) para registrarlos en la gestión de la empresa ${own}.

Cada documento puede ser recibido (lo emite un proveedor y ${own} es el cliente: una compra o un gasto) o emitido (lo emite ${own} para uno de sus clientes: una venta o un ingreso).${direction ? ` Este documento es ${direction}.` : ' Decide cuál es mirando quién aparece como emisor (cabecera, datos fiscales, pie) y quién en el bloque "Cliente", "Facturar a", "Destinatario" o "Entregar a".'}

Cómo rellenar cada dato:
- doc_type: factura (también ticket o factura simplificada), rectificativa (factura rectificativa o de abono), albaran (también nota de entrega), pedido o presupuesto (también oferta o proforma), según el título del documento.
- direccion: recibido o emitido, como se explica arriba.
- proveedor: el tercero, es decir, la otra parte que no es ${own}: el emisor si el documento es recibido, el cliente si es emitido. Razón social tal como aparece, con su forma jurídica si la tiene (S.L., S.A.…).
- nif: NIF/CIF de ese tercero, sin espacios, puntos, guiones ni prefijo "ES".
- categoria: la categoría contable que mejor describe el documento (compras, suministros, alquiler, personal, profesionales, software, marketing, transporte, reparaciones, seguros, bancos, tributos u otros_gastos si es recibido; ventas, servicios u otros_ingresos si es emitido).
- numero: número del documento copiado exactamente como está impreso (letras, guiones, barras y ceros incluidos). No uses números de cliente, de pedido de referencia ni de página.
- fecha y vencimiento: formato dd/mm/aaaa. vencimiento es la fecha límite de pago o de cargo; null si no hay.
- Importes: números con punto decimal, sin símbolo de moneda.
  - base: base imponible total, antes de impuestos.
  - iva: cuota total de IVA; si hay varios tipos, la suma de las cuotas. iva_tipo: el porcentaje si hay un único tipo; null si hay varios.
  - recargo: recargo de equivalencia total, si lo hay. retencion: retención de IRPF en positivo, si la hay.
  - total: importe total del documento. No uses "importe pagado" ni "pendiente" si no son el total.
- forma_pago: breve, como aparece ("Transferencia", "Domiciliación bancaria", "Tarjeta", "Efectivo", "Pagaré 60 días"…).
- iban: el IBAN del documento con espacios cada 4 caracteres.
- lineas: todas las líneas de detalle, en orden. cantidad, precio unitario e importe de la línea tal como figuran; null si una columna no existe (por ejemplo, albaranes sin precios).

Un dato que no aparece en el documento es null. No calcules ni inventes datos que no estén impresos. Si el texto está borroso, da tu mejor lectura del original.`;
}

// Tipos de imagen que admite la API; el resto (TIFF, BMP) se convierte a PNG
const API_IMAGE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

async function documentBlock(buffer, { mime, filename, text }) {
  const ext = path.extname(filename || '').toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  if (/^text\/|xml/.test(mime || '') || ['.txt', '.xml'].includes(ext)) {
    return { type: 'text', text: `Contenido del documento (${ext.slice(1) || 'texto'}):\n\n${buffer.toString('utf8').slice(0, 200_000)}` };
  }
  let data = buffer, media = API_IMAGE[ext];
  // Fotos grandes: se reducen (más rápido y barato; el texto sigue siendo legible)
  let cv = null;
  try { cv = require('@napi-rs/canvas'); } catch {}
  if (cv) {
    try {
      const img = await cv.loadImage(buffer);
      const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
      if (scale < 1 || !media || buffer.length > 4.5 * 1024 * 1024) {
        const c = cv.createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        data = c.toBuffer('image/jpeg', 90); media = 'image/jpeg';
      }
    } catch { /* se envía tal cual */ }
  }
  if (!media) {
    if (!text) throw new Error('Formato de imagen no admitido por la IA');
    return { type: 'text', text: `Texto del documento (leído por OCR, puede tener errores):\n\n${text}` };
  }
  return { type: 'image', source: { type: 'base64', media_type: media, data: data.toString('base64') } };
}

async function callModel(client, model, params) {
  const supportsFallbacks = /^claude-(opus-5|fable)/.test(model);
  if (supportsFallbacks) {
    try {
      return await client.beta.messages.create({ ...params, model, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (e) {
      if (!(e instanceof sdk().BadRequestError)) throw e; // 400: se reintenta sin la opción de reserva
    }
  }
  return client.messages.create({ ...params, model });
}

async function extractWithAi(buffer, { mime, filename, text, ownNif, ownName, direction } = {}) {
  const cfg = config();
  if (!cfg.apiKey) throw new Error('IA no configurada');
  const client = getClient(cfg.apiKey);
  const block = await documentBlock(buffer, { mime, filename, text });
  const content = [block];
  // Para fotos, el texto del OCR sirve de apoyo para cifras pequeñas (la imagen manda)
  if (block.type === 'image' && text && text.trim()) content.push({ type: 'text', text: `Texto aproximado leído por OCR (puede tener errores; en caso de duda manda la imagen):\n${text.slice(0, 12_000)}` });
  content.push({ type: 'text', text: 'Extrae los datos de este documento.' });

  const t0 = Date.now();
  const res = await callModel(client, cfg.model, {
    max_tokens: 16000,
    system: systemPrompt(ownName, ownNif, ['recibido', 'emitido'].includes(direction) ? direction : null),
    thinking: /haiku/.test(cfg.model) ? undefined : { type: 'adaptive' },
    output_config: { ...(/haiku/.test(cfg.model) ? {} : { effort: 'medium' }), format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw new Error('la IA no ha procesado el documento');
  if (res.stop_reason === 'max_tokens') throw new Error('respuesta de la IA incompleta');
  const txt = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let out;
  try { out = JSON.parse(txt); } catch { throw new Error('respuesta de la IA no válida'); }
  return { ...normalize(out), model: res.model || cfg.model, ms: Date.now() - t0, usage: res.usage };
}

// ---------------------------------------------------------------- normalización

const { datesIn, parseAmount } = require('./extract');
function normalize(o) {
  const str = v => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
  const num = v => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v : parseAmount(v));
  const date = v => { const s = str(v); if (!s) return null; const d = datesIn(s); return d[0] || null; };
  const nif = v => { const s = str(v); return s ? s.toUpperCase().replace(/[\s.\-]/g, '').replace(/^ES(?=[A-Z0-9]{9}$)/, '') : null; };
  const iban = v => { const s = str(v); return s ? s.toUpperCase().replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim() : null; };
  const retencion = num(o.retencion);
  return {
    doc_type: ['factura', 'rectificativa', 'albaran', 'pedido', 'presupuesto'].includes(o.doc_type) ? o.doc_type : null,
    direction: ['recibido', 'emitido'].includes(o.direccion) ? o.direccion : null,
    category: [...CATEGORIES.gasto, ...CATEGORIES.ingreso].some(c => c[0] === o.categoria) ? o.categoria : null,
    fields: {
      proveedor: str(o.proveedor), nif: nif(o.nif), numero: str(o.numero), fecha: date(o.fecha), vencimiento: date(o.vencimiento),
      base: num(o.base), iva_tipo: num(o.iva_tipo), iva: num(o.iva), recargo: num(o.recargo), retencion: retencion === null ? null : Math.abs(retencion),
      total: num(o.total), forma_pago: str(o.forma_pago), iban: iban(o.iban),
    },
    lines: (Array.isArray(o.lineas) ? o.lineas : []).map(l => ({ descripcion: str(l.descripcion) || '', cantidad: num(l.cantidad), precio: num(l.precio), importe: num(l.importe) })).filter(l => l.descripcion),
  };
}

// Comprueba la clave sin gastar en una lectura: consulta los datos del modelo elegido
async function testConnection({ apiKey, model } = {}) {
  const cfg = config();
  const key = apiKey || cfg.apiKey;
  if (!key) throw new Error('Falta la clave de la API');
  const m = await new (sdk())({ apiKey: key, timeout: 20_000, maxRetries: 1 }).models.retrieve(model || cfg.model);
  return { ok: true, model: m.id, name: m.display_name };
}

module.exports = { isEnabled, config, extractWithAi, testConnection, MODELS, DEFAULT_MODEL, normalize };
