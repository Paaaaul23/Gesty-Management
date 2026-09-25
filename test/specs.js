'use strict';
// Documentos de prueba con sus valores correctos. generate.js los convierte en PDF digital,
// foto (JPG) y PDF escaneado; eval.js mide cuántos campos acierta el reconocimiento.

// ---------------------------------------------------------------- NIF válidos
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
function cif(letter, digits7) {
  let a = 0, b = 0;
  for (let i = 0; i < 7; i++) {
    const d = +digits7[i];
    if (i % 2 === 1) a += d; else { const x = d * 2; b += Math.floor(x / 10) + (x % 10); }
  }
  const c = (10 - ((a + b) % 10)) % 10;
  return letter + digits7 + ('PQRSNW'.includes(letter) ? 'JABCDEFGHI'[c] : String(c));
}
const dni = n => String(n).padStart(8, '0') + DNI_LETTERS[n % 23];

const OWN = { name: 'Torca 3D S.L.', nif: cif('B', '7654321'), addr: 'Calle Real 12, 36201 Vigo (Pontevedra)' };

const r2 = n => Math.round(n * 100) / 100;
function totals(lines, { irpf = 0, re = false } = {}) {
  const byRate = {};
  for (const l of lines) {
    const imp = r2(l.q * l.p * (1 - (l.dto || 0) / 100));
    l.imp = imp;
    byRate[l.iva] = r2((byRate[l.iva] || 0) + imp);
  }
  const base = r2(Object.values(byRate).reduce((a, b) => a + b, 0));
  const rates = Object.keys(byRate).map(Number);
  const ivaParts = rates.map(r => ({ rate: r, base: byRate[r], cuota: r2(byRate[r] * r / 100) }));
  const iva = r2(ivaParts.reduce((a, p) => a + p.cuota, 0));
  const reAmt = re ? r2(ivaParts.reduce((a, p) => a + p.base * ({ 21: 5.2, 10: 1.4, 4: 0.5 }[p.rate] || 0) / 100, 0)) : 0;
  const irpfAmt = r2(base * irpf / 100);
  return { base, ivaParts, iva, iva_tipo: rates.length === 1 ? rates[0] : null, re: reAmt, irpf: irpfAmt, total: r2(base + iva + reAmt - irpfAmt) };
}

const specs = [
  {
    id: 'f01-clasica', type: 'factura', layout: 'clasica',
    supplier: { name: 'Distribuciones Norte S.L.', nif: cif('B', '3625148'), addr: 'Polígono A Granxa, Parcela 14, 36400 Porriño', phone: '986 334 512', email: 'facturacion@disnorte.es' },
    numero: 'F-2024/0153', fecha: '12/03/2024', vencimiento: '11/04/2024', pago: 'Transferencia bancaria', iban: 'ES91 2100 0418 4502 0005 1332',
    lines: [{ d: 'Filamento PLA 1,75 mm negro 1 kg', q: 12, p: 18.5, iva: 21 }, { d: 'Filamento PETG 1,75 mm transparente 1 kg', q: 6, p: 22.9, iva: 21 }, { d: 'Boquilla latón 0,4 mm (pack 10)', q: 3, p: 9.75, iva: 21 }],
  },
  {
    id: 'f02-cabecera-tabla', type: 'factura', layout: 'cabeceraTabla',
    supplier: { name: 'Suministros Industriales Galaicos S.A.', nif: cif('A', '1502473'), addr: 'Avda. de Madrid 221, 36214 Vigo', phone: '986 20 30 40', email: 'admin@sigalsa.com' },
    numero: 'A-1023', fecha: '05/02/2024', vencimiento: '06/03/2024', pago: 'Recibo domiciliado', iban: 'ES66 0182 5322 2102 0161 7382',
    lines: [{ d: 'Tornillo DIN 912 M4x12 inox (caja 200)', q: 4, p: 14.2, iva: 21 }, { d: 'Tuerca DIN 934 M4 inox (caja 500)', q: 2, p: 11.6, iva: 21 }, { d: 'Arandela plana M4 (caja 500)', q: 2, p: 6.3, iva: 21 }, { d: 'Portes', q: 1, p: 8.5, iva: 21 }],
  },
  {
    id: 'f03-dos-columnas', type: 'factura', layout: 'dosColumnas', ownFirst: true,
    supplier: { name: 'Gráficas Atlántico S.L.U.', nif: cif('B', '2786015'), addr: 'Rúa do Progreso 45, 32003 Ourense', phone: '988 21 45 67', email: 'hola@graficasatlantico.gal' },
    numero: '2024-00087', fecha: '15/03/2024', fechaTexto: '15 de marzo de 2024', vencimiento: '14/04/2024', pago: 'Transferencia', iban: 'ES21 0081 0216 7300 0118 9230',
    lines: [{ d: 'Tarjetas de visita 350 g (1000 uds)', q: 2, p: 38, iva: 21 }, { d: 'Flyer A5 couché 135 g (2500 uds)', q: 1, p: 96.4, iva: 21 }, { d: 'Diseño gráfico (horas)', q: 3, p: 35, iva: 21 }],
  },
  {
    id: 'f04-varios-iva', type: 'factura', layout: 'clasica',
    supplier: { name: 'Cash Galicia Hostelería S.L.', nif: cif('B', '9412370'), addr: 'Rúa Industria 8, 15008 A Coruña', phone: '981 17 22 90', email: 'clientes@cashgalicia.es' },
    numero: 'CG24-004512', fecha: '21/06/2024', pago: 'Tarjeta',
    lines: [{ d: 'Aceite de oliva virgen extra 5 L', q: 2, p: 34.9, iva: 10 }, { d: 'Café en grano natural 1 kg', q: 4, p: 16.4, iva: 10 }, { d: 'Detergente lavavajillas 10 L', q: 1, p: 21.5, iva: 21 }, { d: 'Servilletas 2 capas (paquete 100)', q: 10, p: 1.85, iva: 21 }, { d: 'Pan de molde', q: 3, p: 2.1, iva: 4 }],
  },
  {
    id: 'f05-autonomo-irpf', type: 'factura', layout: 'clasica', irpf: 15,
    supplier: { name: 'Laura Méndez Otero', nif: dni(35467281), addr: 'Rúa Urzáiz 77, 3º B, 36204 Vigo', phone: '644 123 987', email: 'laura.mendez.asesora@gmail.com' },
    numero: '2024/019', fecha: '31/01/2024', pago: 'Transferencia bancaria', iban: 'ES79 2100 0813 6101 2345 6789',
    lines: [{ d: 'Asesoría fiscal y contable enero 2024', q: 1, p: 180, iva: 21 }, { d: 'Presentación modelos 303 y 111', q: 1, p: 45, iva: 21 }],
  },
  {
    id: 'f06-ticket', type: 'factura', layout: 'ticket',
    supplier: { name: 'Ferretería O Castro S.L.', nif: cif('B', '3690142'), addr: 'Rúa Castro 3, 36204 Vigo', phone: '986 41 22 10' },
    numero: 'T001-005821', fecha: '08/04/2024', pago: 'Efectivo',
    lines: [{ d: 'Cinta americana gris', q: 2, p: 4.95, iva: 21 }, { d: 'Brocas HSS juego 13', q: 1, p: 17.9, iva: 21 }, { d: 'Guantes nitrilo T9', q: 1, p: 6.5, iva: 21 }],
  },
  {
    id: 'f07-tabla-totales', type: 'factura', layout: 'tablaTotales',
    supplier: { name: 'ElectroVigo Componentes S.L.', nif: cif('B', '2750938'), addr: 'Rúa Coruña 12, 36208 Vigo', phone: '986 48 00 12', email: 'pedidos@electrovigo.es' },
    numero: 'FV/24/1188', fecha: '02/05/2024', vencimiento: '01/06/2024', pago: 'Transferencia 30 días', iban: 'ES12 2080 5000 6130 4000 1234',
    lines: [{ d: 'Placa Arduino Mega 2560', q: 3, p: 38.9, iva: 21 }, { d: 'Driver motor paso a paso TMC2209', q: 10, p: 7.45, iva: 21 }, { d: 'Fuente alimentación 24V 15A', q: 2, p: 42.3, iva: 21 }, { d: 'Cable silicona 18AWG (10 m)', q: 5, p: 6.8, iva: 21 }],
  },
  {
    id: 'f08-sin-forma-juridica', type: 'factura', layout: 'dosColumnas',
    supplier: { name: 'Frutas Hermanos Pereira', nif: cif('E', '3604728'), addr: 'Mercado do Calvario, puesto 22, 36205 Vigo', phone: '986 27 11 45' },
    numero: '000341', fecha: '10/07/2024', pago: 'Contado',
    lines: [{ d: 'Limón Verna (kg)', q: 8, p: 2.2, iva: 4 }, { d: 'Naranja zumo (kg)', q: 15, p: 1.35, iva: 4 }, { d: 'Menta fresca (manojo)', q: 6, p: 1.1, iva: 4 }],
  },
  {
    id: 'f09-euro-delante', type: 'factura', layout: 'moderna', euroFirst: true,
    supplier: { name: 'CloudHost Iberia S.L.', nif: cif('B', '8766105'), addr: 'Calle de Alcalá 180, 28028 Madrid', email: 'billing@cloudhost.es' },
    numero: 'INV-2024-03371', fecha: '01/08/2024', vencimiento: '01/08/2024', pago: 'Tarjeta de crédito',
    lines: [{ d: 'Servidor VPS 4 vCPU / 8 GB — agosto 2024', q: 1, p: 24.9, iva: 21 }, { d: 'Dominio torca3d.es (renovación anual)', q: 1, p: 12.5, iva: 21 }, { d: 'Copias de seguridad 100 GB', q: 1, p: 4, iva: 21 }],
  },
  {
    id: 'f10-miles', type: 'factura', layout: 'cabeceraTabla',
    supplier: { name: 'Maquinaria 3D Pro S.A.', nif: cif('A', '2816503'), addr: 'C/ Diputació 250, 08007 Barcelona', phone: '93 412 55 00', email: 'ventas@maq3dpro.com' },
    numero: 'FA-24-0402', fecha: '18/09/2024', vencimiento: '18/10/2024', pago: 'Transferencia', iban: 'ES02 0049 1500 0512 1041 0888',
    lines: [{ d: 'Impresora 3D industrial X-Max 600', q: 1, p: 8450, iva: 21 }, { d: 'Kit de mantenimiento anual', q: 1, p: 690, iva: 21 }, { d: 'Instalación y formación (jornada)', q: 2, p: 480, iva: 21 }],
  },
  {
    id: 'a01-albaran-sin-precios', type: 'albaran', layout: 'albaran', noPrices: true,
    supplier: { name: 'Transportes y Logística Miño S.L.', nif: cif('B', '3622984'), addr: 'Polígono Sete Pías, nave 3, 36330 Vigo', phone: '986 25 36 47' },
    numero: 'ALB-24-07731', fecha: '14/05/2024', pedidoRef: 'PED-0921',
    lines: [{ d: 'Bobina PLA 1 kg blanco', q: 20, p: 0, iva: 21 }, { d: 'Bobina PLA 1 kg negro', q: 20, p: 0, iva: 21 }, { d: 'Caja cartón doble canal 60x40x40', q: 15, p: 0, iva: 21 }],
  },
  {
    id: 'a02-albaran-valorado', type: 'albaran', layout: 'albaranValorado',
    supplier: { name: 'Papelería Técnica Bouzas S.L.', nif: cif('B', '2799476'), addr: 'Rúa Tomás Paredes 22, 36208 Vigo', phone: '986 23 45 01', email: 'bouzas@papeleriatecnica.es' },
    numero: '24/1532', fecha: '03/06/2024',
    lines: [{ d: 'Papel A4 80 g (caja 5 paquetes)', q: 4, p: 21.5, iva: 21 }, { d: 'Tóner compatible HP 85A', q: 2, p: 29.9, iva: 21 }, { d: 'Archivador palanca A4', q: 10, p: 2.35, iva: 21 }],
  },
  {
    id: 'a03-nota-entrega', type: 'albaran', layout: 'albaran', noPrices: true, labelStyle: 'nota',
    supplier: { name: 'Bebidas del Noroeste S.L.', nif: cif('B', '1583620'), addr: 'Estrada de Madrid 140, 36214 Vigo', phone: '986 11 22 33' },
    numero: '88213', fecha: '22/07/2024',
    lines: [{ d: 'Agua mineral 1,5 L (pack 6)', q: 10, p: 0, iva: 10 }, { d: 'Refresco cola 33 cl (pack 24)', q: 4, p: 0, iva: 10 }, { d: 'Cerveza Estrella Galicia 33 cl (caja 24)', q: 6, p: 0, iva: 21 }],
  },
  {
    id: 'p01-pedido', type: 'pedido', layout: 'pedido',
    supplier: { name: 'Resinas y Polímeros Levante S.L.', nif: cif('B', '9730184'), addr: 'Camí de la Mar 18, 46120 Alboraia (Valencia)', email: 'pedidos@resinaslevante.es' },
    numero: 'PED-2024-0112', fecha: '20/02/2024',
    lines: [{ d: 'Resina estándar gris 1 L', q: 6, p: 39.9, iva: 21 }, { d: 'Resina flexible 80A 1 L', q: 2, p: 64.5, iva: 21 }, { d: 'Alcohol isopropílico 99% 5 L', q: 2, p: 27.4, iva: 21 }],
  },
  {
    id: 'f11-recargo', type: 'factura', layout: 'tablaTotales', re: true,
    supplier: { name: 'Mayorista Textil Rías Baixas S.L.', nif: cif('B', '3688213'), addr: 'Rúa Romil 40, 36202 Vigo', phone: '986 42 71 90', email: 'mayorista@textilrias.es' },
    numero: 'MT-2024-1045', fecha: '11/10/2024', pago: 'Pagaré 60 días',
    lines: [{ d: 'Camiseta algodón 180 g blanca (caja 50)', q: 2, p: 112.5, iva: 21 }, { d: 'Sudadera capucha negra (caja 20)', q: 1, p: 238, iva: 21 }],
  },
  {
    id: 'f12-etiqueta-encima', type: 'factura', layout: 'etiquetaEncima',
    supplier: { name: 'Carpintería Metálica Lavadores S.L.', nif: cif('B', '2744106'), addr: 'Camiño do Monte 5, 36214 Vigo', phone: '986 37 88 12', email: 'info@cmlavadores.es' },
    numero: '2024-0356', fecha: '29/11/2024', vencimiento: '29/12/2024', pago: 'Transferencia', iban: 'ES44 2100 5731 7002 0012 3456',
    lines: [{ d: 'Estructura aluminio perfil 40x40 (m)', q: 18, p: 11.6, iva: 21 }, { d: 'Escuadra de unión 40 (ud)', q: 24, p: 2.4, iva: 21 }, { d: 'Mano de obra montaje (h)', q: 6, p: 32, iva: 21 }],
  },
];

for (const s of specs) {
  s.own = OWN;
  s.t = totals(s.lines, { irpf: s.irpf || 0, re: s.re });
  const priced = !s.noPrices;
  s.expected = {
    doc_type: s.type,
    fields: {
      proveedor: s.supplier.name,
      nif: s.supplier.nif,
      numero: s.numero,
      fecha: s.fecha,
      vencimiento: s.vencimiento || null,
      base: priced ? s.t.base : null,
      iva_tipo: priced ? s.t.iva_tipo : null,
      iva: priced ? s.t.iva : null,
      total: priced ? s.t.total : null,
      forma_pago: s.pago || null,
      iban: s.iban || null,
    },
    lines: s.lines.map(l => ({ descripcion: l.d, cantidad: l.q, precio: priced ? l.p : null, importe: priced ? l.imp : null })),
  };
}

module.exports = { specs, OWN, cif, dni };

// ---------------------------------------------------------------- control (no usados para ajustar)
// Maquetaciones nuevas para comprobar que las mejoras generalizan y no están hechas a medida.
const holdout = [
  {
    id: 'h01-restaurante', type: 'factura', layout: 'hRestaurante',
    supplier: { name: 'Pescados Ría de Arousa S.L.', nif: cif('B', '3659127'), addr: 'Peirao de Vilaxoán s/n, 36600 Vilagarcía de Arousa', phone: '986 50 12 34' },
    numero: 'PRA-000981', fecha: '04/03/2025', vencimiento: '03/04/2025', pago: 'Domiciliación bancaria', iban: 'ES76 2080 5801 1012 3456 7891',
    lines: [{ d: 'Merluza del pincho (kg)', q: 6.5, p: 14.8, iva: 10 }, { d: 'Mejillón de roca (malla 5 kg)', q: 3, p: 11.25, iva: 10 }, { d: 'Pulpo cocido (kg)', q: 2.4, p: 24.5, iva: 10 }],
  },
  {
    id: 'h02-albaran-compacto', type: 'albaran', layout: 'hAlbaranCompacto', noPrices: true,
    supplier: { name: 'Almacenes Eléctricos Sampaio S.A.', nif: cif('A', '3613882'), addr: 'Rúa Sampaio 9, 36310 Vigo', phone: '986 42 00 11' },
    numero: 'AE-55120', fecha: '17/01/2025',
    lines: [{ d: 'Cable RV-K 3G2,5 (rollo 100 m)', q: 2, p: 0, iva: 21 }, { d: 'Magnetotérmico 2P 16A', q: 6, p: 0, iva: 21 }, { d: 'Caja estanca 100x100', q: 12, p: 0, iva: 21 }, { d: 'Regleta 12 polos', q: 4, p: 0, iva: 21 }],
  },
  {
    id: 'h03-servicios', type: 'factura', layout: 'hServicios', irpf: 7,
    supplier: { name: 'Diego Fernández Castro', nif: dni(76834512), addr: 'Avda. Castelao 3, 5º A, 36209 Vigo', email: 'diego.fdez.disenio@gmail.com' },
    numero: '2025-004', fecha: '28/02/2025', pago: 'Transferencia', iban: 'ES91 0049 1500 0512 1041 0888',
    lines: [{ d: 'Modelado 3D de pieza para cliente final', q: 8, p: 30, iva: 21 }, { d: 'Renderizado fotorrealista', q: 2, p: 45, iva: 21 }],
  },
  {
    id: 'h04-suministro', type: 'factura', layout: 'hSuministro', noQtyCols: true,
    supplier: { name: 'Energía Verde del Norte S.L.', nif: cif('B', '8819352'), addr: 'Paseo de la Castellana 95, 28046 Madrid', phone: '900 100 200' },
    numero: 'EVN25-0203-44871', fecha: '05/03/2025', vencimiento: '20/03/2025', pago: 'Domiciliación', iban: 'ES14 1465 0100 9119 0012 3456',
    lines: [{ d: 'Término de potencia (4,6 kW x 28 días)', q: 1, p: 12.87, iva: 21 }, { d: 'Término de energía (412 kWh)', q: 1, p: 61.8, iva: 21 }, { d: 'Alquiler de contador', q: 1, p: 0.75, iva: 21 }],
  },
];
for (const s of holdout) {
  s.own = OWN;
  s.t = totals(s.lines, { irpf: s.irpf || 0, re: s.re });
  const priced = !s.noPrices;
  s.expected = {
    doc_type: s.type,
    fields: { proveedor: s.supplier.name, nif: s.supplier.nif, numero: s.numero, fecha: s.fecha, vencimiento: s.vencimiento || null,
      base: priced ? s.t.base : null, iva_tipo: priced ? s.t.iva_tipo : null, iva: priced ? s.t.iva : null, total: priced ? s.t.total : null,
      forma_pago: s.pago || null, iban: s.iban || null },
    lines: s.lines.map(l => ({ descripcion: l.d, cantidad: s.noQtyCols ? null : l.q, precio: priced && !s.noQtyCols ? l.p : null, importe: priced ? l.imp : null })),
  };
}
specs.push(...holdout);
