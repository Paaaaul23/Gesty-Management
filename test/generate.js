'use strict';
// Genera los documentos de prueba en test/fixtures a partir de specs.js:
//   <id>.pdf        PDF digital (con capa de texto)
//   <id>.jpg        foto: ligeramente girada, con desenfoque y ruido (pasa por OCR)
//   <id>-scan.pdf   PDF escaneado sin texto (pasa por OCR)
//   <id>.json       valores correctos
// Uso (herramienta de desarrollo, necesita Playwright y Chromium):
//   npm i --no-save playwright && node test/generate.js
const fs = require('node:fs');
const path = require('node:path');
const { specs } = require('./specs');

const OUT = path.join(__dirname, 'fixtures');
const eur = (n, s = {}) => {
  if (n === null || n === undefined) return '';
  const txt = s.euroFirst ? n.toFixed(2) : n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
  return s.euroFirst ? `€${txt}` : `${txt} €`;
};
const qty = n => String(n).replace('.', ',');
const esc = v => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const CSS = `
*{box-sizing:border-box} body{margin:0;font:13px/1.45 "Liberation Sans",Arial,sans-serif;color:#1b1b1b;background:#fff}
.page{width:794px;min-height:1123px;padding:54px 58px;position:relative}
h1{font-size:26px;margin:0 0 4px;letter-spacing:.02em} .muted{color:#555} .small{font-size:11px}
table{width:100%;border-collapse:collapse} th,td{padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eef1f4;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em} td.n,th.n{text-align:right}
.lines td{border-bottom:1px solid #ddd} .box{border:1px solid #bbb;padding:10px 12px;border-radius:4px}
.row{display:flex;gap:24px;justify-content:space-between} .right{text-align:right}
.tot td{padding:4px 8px} .tot tr.big td{font-weight:bold;font-size:15px;border-top:2px solid #333}
.logo{font-weight:800;font-size:20px;color:#1f4e79}
`;

function linesTable(s, { withIva = false, dto = false } = {}) {
  const noP = s.noPrices;
  return `<table class="lines"><thead><tr>
    ${s.layout === 'ticket' ? '' : '<th>Ref.</th>'}<th>Descripción</th><th class="n">Cantidad</th>${noP ? '' : `<th class="n">Precio</th>${withIva ? '<th class="n">IVA</th>' : ''}<th class="n">Importe</th>`}
  </tr></thead><tbody>
  ${s.lines.map((l, i) => `<tr>${s.layout === 'ticket' ? '' : `<td>${String(1000 + i * 7)}</td>`}<td>${esc(l.d)}</td><td class="n">${qty(l.q)}</td>${noP ? '' : `<td class="n">${eur(l.p, s)}</td>${withIva ? `<td class="n">${l.iva}%</td>` : ''}<td class="n">${eur(l.imp, s)}</td>`}</tr>`).join('')}
  </tbody></table>`;
}

function totalsBlock(s) {
  const t = s.t;
  const rows = [];
  rows.push(['Base imponible', eur(t.base, s)]);
  for (const p of t.ivaParts) rows.push([`IVA ${p.rate}%${t.ivaParts.length > 1 ? ` s/ ${eur(p.base, s)}` : ''}`, eur(p.cuota, s)]);
  if (t.re) rows.push(['Recargo de equivalencia', eur(t.re, s)]);
  if (t.irpf) rows.push([`Retención IRPF ${s.irpf}%`, '-' + eur(t.irpf, s)]);
  rows.push([s.type === 'presupuesto' ? 'TOTAL PRESUPUESTO' : 'TOTAL FACTURA', eur(t.total, s)]);
  return `<table class="tot" style="width:330px;margin-left:auto;margin-top:16px">${rows.map((r, i) => `<tr class="${i === rows.length - 1 ? 'big' : ''}"><td>${r[0]}</td><td class="n">${r[1]}</td></tr>`).join('')}</table>`;
}

function taxTable(s) {
  const t = s.t;
  return `<table style="margin-top:18px"><thead><tr><th class="n">Base imponible</th><th class="n">% IVA</th><th class="n">Cuota IVA</th>${t.re ? '<th class="n">Rec. equiv.</th>' : ''}<th class="n">Total factura</th></tr></thead>
  <tbody><tr><td class="n">${eur(t.base, s)}</td><td class="n">${t.ivaParts.map(p => p.rate + '%').join(' / ')}</td><td class="n">${eur(t.iva, s)}</td>${t.re ? `<td class="n">${eur(t.re, s)}</td>` : ''}<td class="n"><b>${eur(t.total, s)}</b></td></tr></tbody></table>`;
}

const supplierBlock = s => `<div><div class="logo">${esc(s.supplier.name)}</div>
  <div>${esc(s.supplier.addr)}</div><div>CIF: ${s.supplier.nif}</div>
  ${s.supplier.phone ? `<div>Tel.: ${s.supplier.phone}</div>` : ''}${s.supplier.email ? `<div>${s.supplier.email}</div>` : ''}</div>`;
const clientBlock = (s, label = 'Cliente') => s.type === 'presupuesto' && label === 'Cliente' ? clientBlockRaw(s, 'Para') : clientBlockRaw(s, label);
const clientBlockRaw = (s, label) => `<div class="box"><div class="small muted">${label}</div><b>${esc(s.own.name)}</b><div>${esc(s.own.addr)}</div><div>NIF: ${s.own.nif}</div></div>`;
const payBlock = s => (s.pago || s.iban) ? `<div style="margin-top:22px" class="small">${s.pago ? `<div><b>Forma de pago:</b> ${esc(s.pago)}</div>` : ''}${s.iban ? `<div><b>IBAN:</b> ${s.iban}</div>` : ''}${s.vencimiento && s.layout !== 'cabeceraTabla' && s.layout !== 'etiquetaEncima' ? `<div><b>Vencimiento:</b> ${s.vencimiento}</div>` : ''}</div>` : '';
const footer = s => `<div class="small muted" style="position:absolute;bottom:40px;left:58px;right:58px">${esc(s.supplier.name)} · Inscrita en el Registro Mercantil · CIF ${s.supplier.nif}</div>`;

const layouts = {
  clasica: s => `${supplierBlock(s)}
    <div class="row" style="margin-top:26px"><div><h1>${s.title || 'FACTURA'}</h1>
      <div>${s.numLabel || 'Nº Factura'}: <b>${s.numero}</b></div><div>Fecha: ${s.fecha}</div></div>${clientBlock(s)}</div>
    <div style="margin-top:24px">${linesTable(s, { withIva: s.t.ivaParts.length > 1 })}</div>${totalsBlock(s)}${payBlock(s)}`,

  cabeceraTabla: s => `<div class="row">${supplierBlock(s)}<div class="right"><h1>FACTURA</h1></div></div>
    <table style="margin-top:22px"><thead><tr><th>Nº factura</th><th>Fecha</th><th>Vencimiento</th><th>Cliente</th></tr></thead>
      <tbody><tr><td>${s.numero}</td><td>${s.fecha}</td><td>${s.vencimiento || ''}</td><td>C-0042</td></tr></tbody></table>
    <div style="margin-top:14px">${clientBlock(s, 'Facturar a')}</div>
    <div style="margin-top:20px">${linesTable(s)}</div>${taxTable(s)}${payBlock(s)}`,

  dosColumnas: s => `<div class="row">
      ${s.ownFirst ? clientBlock(s, 'Datos del cliente') : supplierBlock(s)}
      <div class="right">${s.ownFirst ? supplierBlock(s) : ''}<h1 style="margin-top:10px">Factura</h1>
        <div>Número: ${s.numero}</div><div>Fecha de emisión: ${s.fechaTexto || s.fecha}</div>${s.vencimiento ? `<div>Fecha de vencimiento: ${s.vencimiento}</div>` : ''}</div></div>
    ${s.ownFirst ? '' : `<div style="margin-top:16px;width:360px">${clientBlock(s)}</div>`}
    <div style="margin-top:24px">${linesTable(s)}</div>${totalsBlock(s)}${payBlock(s)}`,

  ticket: s => `<div style="width:340px;margin:auto;text-align:center">
      <b style="font-size:16px">${esc(s.supplier.name).toUpperCase()}</b><div>${esc(s.supplier.addr)}</div><div>NIF ${s.supplier.nif} · Tel. ${s.supplier.phone}</div>
      <div style="margin:10px 0">FACTURA SIMPLIFICADA<br>Nº ${s.numero}<br>${s.fecha} 17:42</div>
      <div style="text-align:left">${linesTable(s)}</div>
      <table class="tot" style="margin-top:10px">
        <tr><td>Base imponible</td><td class="n">${eur(s.t.base)}</td></tr>
        <tr><td>IVA ${s.t.iva_tipo}%</td><td class="n">${eur(s.t.iva)}</td></tr>
        <tr class="big"><td>TOTAL (IVA incl.)</td><td class="n">${eur(s.t.total)}</td></tr></table>
      <div style="margin-top:10px">Pago: ${s.pago}</div><div class="small">Gracias por su visita</div></div>`,

  tablaTotales: s => `<div class="row">${supplierBlock(s)}<div class="right"><h1>FACTURA</h1><div>Nº: ${s.numero}</div><div>Fecha: ${s.fecha}</div></div></div>
    <div style="margin-top:16px;width:360px">${clientBlock(s)}</div>
    <div style="margin-top:22px">${linesTable(s)}</div>${taxTable(s)}${payBlock(s)}${s.vencimiento ? '' : ''}`,

  moderna: s => `<div class="row"><div><div class="logo" style="font-size:24px">${esc(s.supplier.name)}</div><div class="muted">${esc(s.supplier.addr)} · VAT ID ES${s.supplier.nif}</div><div class="muted">${s.supplier.email}</div></div></div>
    <h1 style="margin-top:30px">Factura ${s.numero}</h1>
    <div class="muted">Fecha de factura ${s.fecha} · Fecha de vencimiento ${s.vencimiento}</div>
    <div style="margin-top:14px">${clientBlock(s, 'Facturado a')}</div>
    <div style="margin-top:22px">${linesTable(s)}</div>
    <table class="tot" style="width:330px;margin-left:auto;margin-top:16px"><tr><td>Subtotal</td><td class="n">${eur(s.t.base, s)}</td></tr><tr><td>IVA (${s.t.iva_tipo}%)</td><td class="n">${eur(s.t.iva, s)}</td></tr><tr class="big"><td>Importe pagado</td><td class="n">${eur(s.t.total, s)}</td></tr></table>
    <div style="margin-top:20px" class="small">Pagado con ${s.pago}</div>`,

  albaran: s => `<div class="row">${supplierBlock(s)}<div class="right"><h1>${s.labelStyle === 'nota' ? 'NOTA DE ENTREGA' : 'ALBARÁN'}</h1>
      <div>${s.labelStyle === 'nota' ? 'Nota nº' : 'Nº albarán'}: ${s.numero}</div><div>Fecha: ${s.fecha}</div>${s.pedidoRef ? `<div>Su pedido: ${s.pedidoRef}</div>` : ''}</div></div>
    <div style="margin-top:16px;width:360px">${clientBlock(s, 'Entregar a')}</div>
    <div style="margin-top:22px">${linesTable(s)}</div>
    <div class="row" style="margin-top:60px"><div>Firma y sello del receptor: ____________________</div><div>Bultos: ${s.lines.length}</div></div>`,

  albaranValorado: s => `<div class="row">${supplierBlock(s)}<div class="right"><h1>ALBARÁN</h1><div>Número: ${s.numero}</div><div>Fecha: ${s.fecha}</div></div></div>
    <div style="margin-top:16px;width:360px">${clientBlock(s)}</div>
    <div style="margin-top:22px">${linesTable(s)}</div>${totalsBlock(s).replace('TOTAL FACTURA', 'TOTAL ALBARÁN')}`,

  pedido: s => `<div class="row">${clientBlock(s, 'Solicitante')}<div class="right"><h1>PEDIDO</h1><div>Nº pedido: ${s.numero}</div><div>Fecha: ${s.fecha}</div></div></div>
    <div style="margin-top:16px"><div class="small muted">Proveedor</div>${supplierBlock(s)}</div>
    <div style="margin-top:22px">${linesTable(s)}</div>${totalsBlock(s).replace('TOTAL FACTURA', 'TOTAL PEDIDO')}`,

  etiquetaEncima: s => `<div class="row">${supplierBlock(s)}<div style="width:300px">
      <h1>FACTURA</h1>
      <table><tr><td class="small muted">NÚMERO DE FACTURA</td><td class="small muted">FECHA</td></tr><tr><td><b>${s.numero}</b></td><td><b>${s.fecha}</b></td></tr>
      <tr><td class="small muted">VENCIMIENTO</td><td></td></tr><tr><td><b>${s.vencimiento}</b></td><td></td></tr></table></div></div>
    <div style="margin-top:16px;width:360px">${clientBlock(s)}</div>
    <div style="margin-top:22px">${linesTable(s)}</div>${totalsBlock(s)}${payBlock(s)}`,
};

const longDate = d => { const [dd, mm, yy] = d.split('/'); return `${+dd} de ${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][mm - 1]} de ${yy}`; };

Object.assign(layouts, {
  hRestaurante: s => `<div style="background:#0b3954;color:#fff;padding:16px 20px;text-align:center;border-radius:6px">
      <div style="font-size:22px;font-weight:800">${esc(s.supplier.name)}</div><div>${esc(s.supplier.addr)} · Tlf ${s.supplier.phone} · C.I.F. ${s.supplier.nif}</div></div>
    <div class="row" style="margin-top:20px"><div><b>FRA. Nº ${s.numero}</b><br>Vilagarcía, ${longDate(s.fecha)}</div>
      <div class="box" style="width:330px"><b>${esc(s.own.name)}</b><br>${esc(s.own.addr)}<br>C.I.F. ${s.own.nif}</div></div>
    <table class="lines" style="margin-top:20px"><thead><tr><th>Producto</th><th class="n">Kg/Uds</th><th class="n">€/ud</th><th class="n">Total</th></tr></thead><tbody>
      ${s.lines.map(l => `<tr><td>${esc(l.d)}</td><td class="n">${qty(l.q)}</td><td class="n">${eur(l.p)}</td><td class="n">${eur(l.imp)}</td></tr>`).join('')}</tbody></table>
    <div style="margin-top:16px;margin-left:auto;width:300px">
      <div class="row"><span>Base 10%</span><span>${eur(s.t.base)}</span></div><div class="row"><span>Cuota 10%</span><span>${eur(s.t.iva)}</span></div>
      <div class="row" style="font-weight:bold;font-size:16px;border-top:1px solid #000;margin-top:6px;padding-top:6px"><span>Total a pagar</span><span>${eur(s.t.total)}</span></div></div>
    <div style="margin-top:26px" class="small">Cobro: ${s.pago} en ${s.iban} el ${s.vencimiento}</div>`,

  hAlbaranCompacto: s => `<div class="row"><div class="logo">${esc(s.supplier.name.split(' ').slice(0, 2).join(' '))}</div><div class="right small">Albarán nº <b>${s.numero}</b> del ${s.fecha}</div></div>
    <div style="margin-top:14px" class="small">Entregado a: <b>${esc(s.own.name)}</b> — ${esc(s.own.addr)}</div>
    <table class="lines" style="margin-top:18px"><thead><tr><th>Código</th><th>Artículo</th><th class="n">Uds.</th></tr></thead><tbody>
      ${s.lines.map((l, i) => `<tr><td>E${4410 + i * 3}</td><td>${esc(l.d)}</td><td class="n">${qty(l.q)}</td></tr>`).join('')}</tbody></table>
    <div style="margin-top:40px">Recibí conforme: ____________________</div>
    <div class="small muted" style="position:absolute;bottom:40px;left:58px;right:58px;text-align:center">${esc(s.supplier.name)} · ${esc(s.supplier.addr)} · Tel. ${s.supplier.phone} · CIF ${s.supplier.nif}</div>`,

  hServicios: s => `<div class="right"><b>${esc(s.supplier.name)}</b><br>${esc(s.supplier.addr)}<br>NIF ${s.supplier.nif}<br>${s.supplier.email}</div>
    <div style="margin-top:20px">${esc(s.own.name)}<br>${esc(s.own.addr)}<br>CIF ${s.own.nif}</div>
    <p style="margin-top:26px">Vigo, a ${longDate(s.fecha)}</p><h2>Factura número ${s.numero}</h2>
    <table class="lines"><thead><tr><th>Concepto</th><th class="n">Horas</th><th class="n">Precio/hora</th><th class="n">Importe</th></tr></thead><tbody>
      ${s.lines.map(l => `<tr><td>${esc(l.d)}</td><td class="n">${qty(l.q)}</td><td class="n">${eur(l.p)}</td><td class="n">${eur(l.imp)}</td></tr>`).join('')}</tbody></table>
    <table class="tot" style="width:330px;margin-left:auto;margin-top:16px"><tr><td>Suma</td><td class="n">${eur(s.t.base)}</td></tr><tr><td>IVA (21 %)</td><td class="n">${eur(s.t.iva)}</td></tr>
      <tr><td>IRPF (-${s.irpf} %)</td><td class="n">-${eur(s.t.irpf)}</td></tr><tr class="big"><td>TOTAL A PERCIBIR</td><td class="n">${eur(s.t.total)}</td></tr></table>
    <p style="margin-top:24px">Forma de pago: ${s.pago} a la cuenta ${s.iban}</p>`,

  hSuministro: s => `<div class="row"><div><div class="logo" style="color:#2e7d32">${esc(s.supplier.name)}</div><div class="small">${esc(s.supplier.addr)} · CIF ${s.supplier.nif}</div></div><div class="box small">Atención al cliente<br><b>${s.supplier.phone}</b></div></div>
    <div class="row" style="margin-top:22px"><div class="box" style="width:48%"><b>Datos de la factura</b><br>Nº de factura: ${s.numero}<br>Fecha de emisión: ${s.fecha}<br>Periodo: 01/02/2025 - 28/02/2025<br>Fecha de cargo: ${s.vencimiento}</div>
      <div class="box" style="width:48%"><b>Titular del contrato</b><br>${esc(s.own.name)}<br>${esc(s.own.addr)}<br>NIF: ${s.own.nif}</div></div>
    <div style="margin-top:22px;font-size:20px">Importe total: <b>${eur(s.t.total)}</b></div>
    <table class="lines" style="margin-top:14px"><thead><tr><th>Concepto</th><th class="n">Importe</th></tr></thead><tbody>
      ${s.lines.map(l => `<tr><td>${esc(l.d)}</td><td class="n">${eur(l.imp)}</td></tr>`).join('')}
      <tr><td>Base imponible</td><td class="n">${eur(s.t.base)}</td></tr><tr><td>IVA 21%</td><td class="n">${eur(s.t.iva)}</td></tr></tbody></table>
    <p class="small" style="margin-top:20px">Modo de pago: ${s.pago}. Cuenta de cargo: ${s.iban}</p>`,
});

(async () => {
  const { chromium } = require('playwright');
  fs.mkdirSync(OUT, { recursive: true });
  const exe = fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers').filter(d => /^chromium-\d/.test(d)).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`)[0] : undefined;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1.6 });
  for (const s of specs) {
    const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style><div class="page">${layouts[s.layout](s)}${s.layout === 'ticket' ? '' : footer(s)}</div>`;
    await page.setContent(html);
    await page.pdf({ path: path.join(OUT, s.id + '.pdf'), width: '794px', height: '1123px', printBackground: true });
    // Foto: girada, desenfocada y con ruido, como una foto de móvil o un escaneo regular
    const angle = ((s.id.charCodeAt(1) + s.id.length) % 5 - 2) * 0.6;
    await page.setContent(`${html}<style>.page{transform:rotate(${angle}deg);filter:blur(.45px) contrast(.9) brightness(.97)}
      body{background:#e9e6df}</style>`);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
    fs.writeFileSync(path.join(OUT, s.id + '.jpg'), jpg);
    // PDF escaneado: solo la imagen, sin capa de texto
    await page.setContent(`<style>body{margin:0}</style><img src="data:image/jpeg;base64,${jpg.toString('base64')}" style="width:794px;height:1123px">`);
    await page.pdf({ path: path.join(OUT, s.id + '-scan.pdf'), width: '794px', height: '1123px' });
    fs.writeFileSync(path.join(OUT, s.id + '.json'), JSON.stringify(s.expected, null, 2));
    console.log('ok', s.id);
  }
  await browser.close();
})();
