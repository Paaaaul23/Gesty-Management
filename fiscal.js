'use strict';
/*
 * Fiscalidad: borradores de los modelos de la AEAT, calendario de plazos, deducibilidad de
 * gastos y reserva recomendada para impuestos, a partir de los apuntes contables (accounting.js).
 *
 * Son BORRADORES orientativos: calculan las casillas principales con los datos registrados en
 * Gesty. La presentación se hace en la Sede Electrónica de la AEAT con certificado digital, y
 * conviene revisarlos con una asesoría (prorrata, regímenes especiales, operaciones
 * intracomunitarias, compensaciones de periodos anteriores… no se contemplan).
 */

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sum = (arr, f) => r2(arr.reduce((a, e) => a + (typeof f === 'function' ? f(e) : e[f] || 0), 0));
const quarterOf = date => Math.ceil(Number(date.slice(5, 7)) / 3);
const yearOf = date => Number(date.slice(0, 4));

// ---------------------------------------------------------------- perfil fiscal

const DEFAULT_PROFILE = {
  forma: 'autonomo',            // autonomo | sociedad
  regimen_iva: 'general',       // general | recargo (comercio minorista) | exento
  irpf_modalidad: 'simplificada', // autónomos: estimación directa simplificada | normal
  exento_130: false,            // autónomos con ≥70 % de ingresos con retención
  is_tipo: 25,                  // sociedades: 25 general, 23 cifra de negocio < 1 M€, 15 emprendedoras
  is_ultima_cuota: null,        // cuota íntegra del último IS (para el 202, art. 40.2)
  tiene_empleados: false,
  alquila_local: false,         // alquiler de local con retención (115)
  trabaja_en_casa: false,       // autónomo con despacho en su vivienda
  pct_vivienda: 0,              // % de la vivienda afecto a la actividad
};
function profileOf(client) {
  let p = {};
  try { p = JSON.parse(client.fiscal_json || '{}') || {}; } catch {}
  const guess = /\b(s\.?\s?l\.?|s\.?\s?a\.?|slu|sociedad)\b/i.test(client.name || '') ? 'sociedad' : 'autonomo';
  return { ...DEFAULT_PROFILE, forma: guess, ...p, configured: !!client.fiscal_json };
}
function cleanProfile(b) {
  const out = {};
  if (['autonomo', 'sociedad'].includes(b.forma)) out.forma = b.forma;
  if (['general', 'recargo', 'exento'].includes(b.regimen_iva)) out.regimen_iva = b.regimen_iva;
  if (['simplificada', 'normal'].includes(b.irpf_modalidad)) out.irpf_modalidad = b.irpf_modalidad;
  if ([25, 23, 15].includes(Number(b.is_tipo))) out.is_tipo = Number(b.is_tipo);
  const n = v => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(',', '.')));
  if ('is_ultima_cuota' in b) out.is_ultima_cuota = Number.isFinite(n(b.is_ultima_cuota)) ? n(b.is_ultima_cuota) : null;
  if ('pct_vivienda' in b) out.pct_vivienda = Math.min(100, Math.max(0, n(b.pct_vivienda) || 0));
  for (const k of ['exento_130', 'tiene_empleados', 'alquila_local', 'trabaja_en_casa']) if (k in b) out[k] = b[k] === true || b[k] === '1' || b[k] === 'true';
  return out;
}

// ---------------------------------------------------------------- deducibilidad

/*
 * Para cada gasto devuelve qué parte es deducible como gasto (IRPF/IS) y qué parte del IVA se
 * puede deducir, con el motivo. "revisar" = depende de circunstancias que Gesty no conoce.
 */
function deductibility(e, profile) {
  const d = { gastoPct: 1, ivaPct: 1, gastoRevisar: false, ivaRevisar: false, motivos: [] };
  const auto = profile.forma === 'autonomo';
  const no = (msg, iva = true, gasto = false) => { if (iva) d.ivaPct = 0; if (gasto) d.gastoPct = 0; d.motivos.push(msg); };
  if (e.kind !== 'gasto') return null;

  if (profile.regimen_iva !== 'general') no(profile.regimen_iva === 'recargo' ? 'En recargo de equivalencia no se deduce el IVA soportado (forma parte del coste).' : 'Actividad exenta de IVA: el IVA soportado no es deducible (forma parte del coste).');
  if (e.source === 'doc' && e.simplificada) {
    if (e.recipientOk === false) no('Ticket o factura simplificada sin tus datos (NIF y domicilio): el IVA no es deducible. Pide factura completa.');
    else if (e.recipientOk === null) { d.ivaRevisar = true; d.motivos.push('Ticket o factura simplificada: el IVA solo es deducible si incluye tu NIF y domicilio.'); }
  }
  switch (e.category) {
    case 'multas':
      no('Las multas y sanciones no son deducibles.', true, true); break;
    case 'viajes':
      d.gastoRevisar = true;
      d.motivos.push(auto ? 'Comidas y viajes: deducibles si son desplazamientos de trabajo pagados por medios electrónicos (comidas en España hasta 26,67 €/día, 53,34 € si pernoctas).'
        : 'Viajes y comidas: deducibles si están relacionados con la actividad y justificados con factura.');
      d.ivaRevisar = true;
      d.motivos.push('El IVA de atenciones a clientes o comidas no ligadas a un viaje de trabajo no es deducible.');
      break;
    case 'vehiculo':
      d.ivaPct = Math.min(d.ivaPct, 0.5);
      d.motivos.push('Vehículo: se presume afectado al 50 % para el IVA (100 % en transportistas, comerciales, autoescuelas…).');
      if (auto) { d.gastoPct = 0; d.gastoRevisar = true; d.motivos.push('Autónomos: el gasto solo es deducible si el vehículo se usa en exclusiva para la actividad.'); }
      break;
    case 'suministros':
      if (auto && profile.trabaja_en_casa) {
        const pct = (profile.pct_vivienda || 0) / 100;
        d.gastoPct = r2(0.3 * pct); d.ivaPct = Math.min(d.ivaPct, pct);
        d.motivos.push(`Trabajas en tu vivienda: se deduce el 30 % de la parte afecta (${profile.pct_vivienda || 0} %) como gasto, y el IVA en la proporción afecta.`);
      }
      break;
    case 'inversion':
      d.gastoRevisar = true;
      d.motivos.push('Bien de inversión: el gasto se deduce mediante amortización durante su vida útil, no de una vez (el IVA sí se deduce entero, casillas 30-31 del 303).');
      break;
    case 'tributos':
      if (/\b(irpf|impuesto sobre (la renta|sociedades)|sociedades)\b/i.test(`${e.concepto} ${e.tercero || ''}`)) no('El propio IRPF o Impuesto sobre Sociedades no es gasto deducible.', true, true);
      break;
  }
  d.gastoDeducible = e.base === null ? 0 : r2(e.base * d.gastoPct + (e.recargo || 0) * d.gastoPct);
  d.ivaDeducible = r2((e.iva || 0) * d.ivaPct);
  d.estado = d.gastoPct === 0 && !d.gastoRevisar ? 'no' : d.gastoRevisar ? 'revisar' : d.gastoPct < 1 ? 'parcial' : 'si';
  d.ivaEstado = !e.iva ? 'sin_iva' : d.ivaPct === 0 && !d.ivaRevisar ? 'no' : d.ivaRevisar ? 'revisar' : d.ivaPct < 1 ? 'parcial' : 'si';
  return d;
}

// ---------------------------------------------------------------- modelos

// Tipo de IVA de un apunte: el leído, o el que sale de cuota / base
function rateOf(e) {
  if ([0, 4, 5, 10, 21].includes(Number(e.ivaRate))) return Number(e.ivaRate);
  if (!e.base) return null;
  const r = Math.abs(e.iva / e.base * 100);
  return [0, 4, 5, 10, 21].find(x => Math.abs(r - x) < 0.3) ?? null;
}

function m303(entries, profile, year, q) {
  const E = entries.filter(e => yearOf(e.date) === year && quarterOf(e.date) === q && !e.incomplete);
  const ing = E.filter(e => e.kind === 'ingreso'), gas = E.filter(e => e.kind === 'gasto');
  const byRate = r => ing.filter(e => rateOf(e) === r);
  const others = ing.filter(e => ![4, 10, 21].includes(rateOf(e)) && e.iva);
  const withD = gas.map(e => ({ e, d: deductibility(e, profile) })).filter(x => x.d && x.d.ivaDeducible);
  const corr = withD.filter(x => x.e.category !== 'inversion'), inv = withD.filter(x => x.e.category === 'inversion');
  const c = {};
  c['01'] = sum(byRate(4), 'base'); c['03'] = sum(byRate(4), 'iva');
  c['04'] = sum(byRate(10), 'base'); c['06'] = sum(byRate(10), 'iva');
  c['07'] = sum(byRate(21), 'base'); c['09'] = sum(byRate(21), 'iva');
  const otros = { base: sum(others, 'base'), cuota: sum(others, 'iva') };
  c['27'] = r2(c['03'] + c['06'] + c['09'] + otros.cuota);
  c['28'] = sum(corr, x => x.e.base * x.d.ivaPct); c['29'] = sum(corr, x => x.d.ivaDeducible);
  c['30'] = sum(inv, x => x.e.base * x.d.ivaPct); c['31'] = sum(inv, x => x.d.ivaDeducible);
  c['45'] = r2(c['29'] + c['31']);
  c['46'] = r2(c['27'] - c['45']);
  c['71'] = c['46'];
  const noDed = r2(sum(gas, 'iva') - c['45']);
  const casillas = [
    ['01', 'Base imponible al 4 %', c['01']], ['03', 'Cuota al 4 %', c['03']],
    ['04', 'Base imponible al 10 %', c['04']], ['06', 'Cuota al 10 %', c['06']],
    ['07', 'Base imponible al 21 %', c['07']], ['09', 'Cuota al 21 %', c['09']],
    ['27', 'Total cuota devengada', c['27']],
    ['28', 'Base de cuotas soportadas en operaciones interiores corrientes', c['28']], ['29', 'Cuotas deducibles (corrientes)', c['29']],
    ['30', 'Base de cuotas soportadas en bienes de inversión', c['30']], ['31', 'Cuotas deducibles (bienes de inversión)', c['31']],
    ['45', 'Total a deducir', c['45']],
    ['46', 'Resultado régimen general (27 − 45)', c['46']],
    ['71', 'Resultado de la liquidación', c['71']],
  ];
  const notes = [];
  if (otros.cuota) notes.push(`Hay ${money(otros.cuota)} de IVA repercutido a otros tipos (0 %, 5 % o facturas con varios tipos) incluido en la casilla 27: repártelo en su casilla al presentar.`);
  if (noDed > 0) notes.push(`${money(noDed)} de IVA soportado no es deducible (tickets sin tus datos, vehículo al 50 %, multas…). Ver Deducibilidad.`);
  if (c['71'] < 0) notes.push(q < 4 ? 'Resultado negativo: se marca "a compensar" y se descuenta en los siguientes trimestres (casilla 110/78).' : 'Resultado negativo en el 4.º trimestre: puedes pedir la devolución o compensarlo el año siguiente.');
  notes.push('Si tienes cuotas a compensar de trimestres anteriores, réstalas en las casillas 110 y 78.');
  return { casillas, result: c['71'], resultLabel: c['71'] > 0 ? 'A ingresar' : c['71'] < 0 ? (q < 4 ? 'A compensar' : 'A devolver o compensar') : 'Sin actividad', notes, count: E.length };
}

function m130(entries, profile, year, q) {
  const upto = qq => entries.filter(e => yearOf(e.date) === year && quarterOf(e.date) <= qq && !e.incomplete);
  const calc = qq => {
    const E = upto(qq);
    const ingresos = sum(E.filter(e => e.kind === 'ingreso'), 'base');
    const gas = E.filter(e => e.kind === 'gasto');
    let gastos = sum(gas, e => deductibility(e, profile).gastoDeducible);
    let dificil = 0;
    if (profile.irpf_modalidad === 'simplificada') dificil = Math.min(2000, Math.max(0, r2((ingresos - gastos) * 0.05)));
    gastos = r2(gastos + dificil);
    const rend = r2(ingresos - gastos);
    const c04 = rend > 0 ? r2(rend * 0.2) : 0;
    const ret = sum(E.filter(e => e.kind === 'ingreso'), 'retencion');
    return { ingresos, gastos, dificil, rend, c04, ret };
  };
  let prevPaid = 0;
  for (let k = 1; k < q; k++) {
    const p = calc(k);
    const r = r2(p.c04 - prevPaid - p.ret);
    if (r > 0) prevPaid = r2(prevPaid + r);
  }
  const x = calc(q);
  const c07 = r2(x.c04 - prevPaid - x.ret);
  const casillas = [
    ['01', 'Ingresos computables (1 de enero hasta fin de trimestre)', x.ingresos],
    ['02', `Gastos fiscalmente deducibles${x.dificil ? ` (incluye ${money(x.dificil)} de difícil justificación, 5 %)` : ''}`, x.gastos],
    ['03', 'Rendimiento neto (01 − 02)', x.rend],
    ['04', '20 % del rendimiento neto', x.c04],
    ['05', 'Pagos fraccionados de trimestres anteriores', prevPaid],
    ['06', 'Retenciones e ingresos a cuenta soportados', x.ret],
    ['07', 'Resultado (04 − 05 − 06)', c07],
    ['19', 'Resultado a ingresar', Math.max(0, c07)],
  ];
  const notes = ['Si en el año anterior tu rendimiento neto fue ≤ 12.000 €, aplica la deducción de la casilla 13 (hasta 100 € por trimestre).'];
  if (c07 < 0) notes.push('Resultado negativo: se presenta a cero y no hay que pagar.');
  return { casillas, result: Math.max(0, c07), resultLabel: c07 > 0 ? 'A ingresar' : 'Negativo o cero', notes };
}

function m202(profile, period) {
  const cuota = Number(profile.is_ultima_cuota) || 0;
  const pago = r2(cuota * 0.18);
  return {
    casillas: [['—', 'Cuota íntegra del último Impuesto sobre Sociedades menos deducciones y retenciones', cuota], ['—', 'Pago fraccionado (18 %, modalidad art. 40.2)', pago]],
    result: pago, resultLabel: pago > 0 ? 'A ingresar' : 'Sin obligación',
    notes: cuota ? [`Periodo ${period}: 18 % de la última cuota del IS. Si tu cifra de negocio supera 6 M€ se usa la modalidad del art. 40.3.`]
      : ['No has indicado la cuota del último Impuesto sobre Sociedades (Configuración → Perfil fiscal). Si fue 0, no hay que presentar el 202.'],
  };
}

// Retenciones practicadas: a profesionales/nóminas (111) y por alquiler de local (115)
function retEntries(entries, year, q, kind) {
  return entries.filter(e => yearOf(e.date) === year && (!q || quarterOf(e.date) === q) && e.kind === 'gasto' && e.retencion > 0 && !e.incomplete)
    .filter(e => kind === '115' ? e.category === 'alquiler' : e.category !== 'alquiler');
}
const perceptores = list => new Set(list.map(e => e.nif || e.tercero || e.concepto)).size;

function m111(entries, year, q) {
  const E = retEntries(entries, year, q, '111');
  const trab = E.filter(e => e.category === 'personal'), prof = E.filter(e => e.category !== 'personal');
  const total = r2(sum(trab, 'retencion') + sum(prof, 'retencion'));
  return {
    casillas: [
      ['01', 'Rendimientos del trabajo: nº de perceptores', perceptores(trab)], ['02', 'Importe de las percepciones', sum(trab, 'base')], ['03', 'Retenciones', sum(trab, 'retencion')],
      ['07', 'Actividades económicas (profesionales): nº de perceptores', perceptores(prof)], ['08', 'Importe de las percepciones', sum(prof, 'base')], ['09', 'Retenciones', sum(prof, 'retencion')],
      ['28', 'Total liquidación', total],
    ],
    result: total, resultLabel: total ? 'A ingresar' : 'Sin retenciones', required: E.length > 0,
    notes: E.length ? ['Las retenciones de nóminas salen de los apuntes manuales de la categoría Personal con retención.'] : ['Sin retenciones en el trimestre: no hace falta presentarlo.'],
    detail: E,
  };
}
function m115(entries, year, q) {
  const E = retEntries(entries, year, q, '115');
  const total = sum(E, 'retencion');
  return {
    casillas: [['01', 'Nº de perceptores', perceptores(E)], ['02', 'Base de las retenciones', sum(E, 'base')], ['03', 'Retenciones e ingresos a cuenta', total]],
    result: total, resultLabel: total ? 'A ingresar' : 'Sin retenciones', required: E.length > 0,
    notes: E.length ? ['Retención del 19 % sobre el alquiler del local (sin IVA).'] : ['Sin retenciones por alquiler en el trimestre.'],
    detail: E,
  };
}

function m390(entries, profile, year) {
  const qs = [1, 2, 3, 4].map(q => m303(entries, profile, year, q));
  const get = k => r2(qs.reduce((a, m) => a + (m.casillas.find(c => c[0] === k)?.[2] || 0), 0));
  const volumen = sum(entries.filter(e => yearOf(e.date) === year && e.kind === 'ingreso' && !e.incomplete), 'base');
  return {
    casillas: [
      ['—', 'Total bases imponibles de IVA devengado', r2(get('01') + get('04') + get('07'))], ['—', 'Total cuotas devengadas', get('27')],
      ['—', 'Total cuotas deducibles', get('45')], ['—', 'Resultado del año (suma de los 303)', get('71')],
      ['108', 'Volumen total de operaciones', volumen],
    ],
    result: null, resultLabel: 'Informativa', notes: ['Resumen anual: debe coincidir con la suma de los cuatro 303 presentados.'],
  };
}

// Operaciones con terceros de más de 3.005,06 € en el año (IVA incluido)
function m347(entries, year) {
  const E = entries.filter(e => yearOf(e.date) === year && e.source === 'doc' && !e.incomplete && !(e.retencion > 0) && e.total);
  const map = {};
  for (const e of E) {
    const key = `${e.kind}|${(e.nif || e.tercero || '').toUpperCase()}`;
    const m = map[key] ||= { clave: e.kind === 'ingreso' ? 'B (ventas)' : 'A (compras)', tercero: e.tercero, nif: e.nif, total: 0, q: [0, 0, 0, 0] };
    m.total = r2(m.total + e.total); m.q[quarterOf(e.date) - 1] = r2(m.q[quarterOf(e.date) - 1] + e.total);
  }
  const list = Object.values(map).filter(m => Math.abs(m.total) > 3005.06).sort((a, b) => b.total - a.total);
  return {
    casillas: list.map(m => [m.clave, `${m.tercero || '—'} (${m.nif || 'sin NIF'}) · T1 ${money(m.q[0])} · T2 ${money(m.q[1])} · T3 ${money(m.q[2])} · T4 ${money(m.q[3])}`, m.total]),
    result: null, resultLabel: list.length ? `${list.length} declarado${list.length > 1 ? 's' : ''}` : 'Sin obligación', required: list.length > 0,
    notes: ['Se excluyen las operaciones con retención (van en el 190/180). Si tienes SII no se presenta.', ...(list.some(m => !m.nif) ? ['Hay terceros sin NIF: complétalo en sus facturas.'] : [])],
    detail: list,
  };
}

function annualRet(entries, year, kind) {
  const E = retEntries(entries, year, null, kind);
  const map = {};
  for (const e of E) {
    const k = e.nif || e.tercero || e.concepto;
    const m = map[k] ||= { tercero: e.tercero || e.concepto, nif: e.nif, base: 0, ret: 0 };
    m.base = r2(m.base + e.base); m.ret = r2(m.ret + e.retencion);
  }
  const list = Object.values(map);
  return {
    casillas: list.map(m => ['—', `${m.tercero} (${m.nif || 'sin NIF'}) · base ${money(m.base)}`, m.ret]),
    result: null, resultLabel: list.length ? `${list.length} perceptor${list.length > 1 ? 'es' : ''}` : 'Sin obligación', required: list.length > 0,
    notes: [kind === '115' ? 'Resumen anual del 115 (arrendadores).' : 'Resumen anual del 111 (trabajadores y profesionales).'], detail: list,
  };
}

// Escala orientativa del IRPF (estatal + autonómica media). Cada comunidad tiene la suya.
function irpfEstimate(base) {
  const tramos = [[12450, 0.19], [20200, 0.24], [35200, 0.30], [60000, 0.37], [300000, 0.45], [Infinity, 0.47]];
  let prev = 0, cuota = 0;
  for (const [lim, t] of tramos) { if (base > prev) cuota += (Math.min(base, lim) - prev) * t; prev = lim; }
  return r2(Math.max(0, cuota - 5550 * 0.19));
}

function annualIncome(entries, profile, year) {
  const E = entries.filter(e => yearOf(e.date) === year && !e.incomplete);
  const ingresos = sum(E.filter(e => e.kind === 'ingreso'), 'base');
  const gastos = sum(E.filter(e => e.kind === 'gasto'), e => deductibility(e, profile).gastoDeducible);
  const rend = r2(ingresos - gastos);
  const retSop = sum(E.filter(e => e.kind === 'ingreso'), 'retencion');
  if (profile.forma === 'sociedad') {
    const cuota = rend > 0 ? r2(rend * profile.is_tipo / 100) : 0;
    const pagos = r2((Number(profile.is_ultima_cuota) || 0) * 0.18 * 3);
    const res = r2(cuota - pagos - retSop);
    return {
      modelo: '200',
      casillas: [['—', 'Resultado contable (ingresos − gastos deducibles)', rend], ['—', `Cuota íntegra estimada (${profile.is_tipo} %)`, cuota],
        ['—', 'Pagos fraccionados (202) del año', pagos], ['—', 'Retenciones soportadas', retSop], ['—', 'Resultado estimado', res]],
      result: res, resultLabel: res > 0 ? 'A ingresar (estimado)' : 'A devolver (estimado)',
      notes: ['Estimación: no incluye ajustes extracontables, bases negativas de años anteriores, reservas de capitalización ni amortizaciones.'],
    };
  }
  const q130 = [1, 2, 3, 4].reduce((a, q) => a + m130(entries, profile, year, q).result, 0);
  const cuota = irpfEstimate(Math.max(0, rend));
  const res = r2(cuota - q130 - retSop);
  return {
    modelo: '100',
    casillas: [['—', 'Rendimiento neto de la actividad', rend], ['—', 'Cuota de IRPF orientativa (solo por la actividad)', cuota],
      ['—', 'Pagos fraccionados (130) del año', r2(q130)], ['—', 'Retenciones soportadas', retSop], ['—', 'Diferencia estimada en la Renta', res]],
    result: res, resultLabel: res > 0 ? 'A pagar en la Renta (estimado)' : 'A devolver (estimado)',
    notes: ['Orientativo: usa una escala media estatal + autonómica y solo los rendimientos de la actividad. La Renta real depende de tus otros ingresos, mínimos familiares y deducciones.'],
  };
}

// ---------------------------------------------------------------- calendario

function shiftWeekend(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const lastDayFeb = y => (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
const QUARTER_DEADLINE = (y, q) => ({ 1: `${y}-04-20`, 2: `${y}-07-20`, 3: `${y}-10-20`, 4: `${y + 1}-01-30` })[q];

const MODELS = {
  303: 'IVA trimestral', 130: 'Pago fraccionado IRPF (autónomos)', 202: 'Pago fraccionado Impuesto sobre Sociedades',
  111: 'Retenciones de trabajadores y profesionales', 115: 'Retenciones por alquiler de local',
  390: 'Resumen anual de IVA', 347: 'Operaciones con terceros (> 3.005,06 €)', 190: 'Resumen anual de retenciones (111)',
  180: 'Resumen anual de retenciones por alquiler (115)', 200: 'Impuesto sobre Sociedades', 100: 'Renta (IRPF) — actividad económica',
};

function money(n) { return (Number(n) || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR', useGrouping: 'always' }); }

// Obligaciones del ejercicio `year` con su borrador calculado y su estado
function calendar(entries, profile, year, filings = [], today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  const filed = (modelo, period) => filings.find(f => f.modelo === String(modelo) && f.year === year && f.period === period);
  const add = (modelo, period, deadline, calc, { required = true } = {}) => {
    const f = filed(modelo, period);
    out.push({ modelo: String(modelo), name: MODELS[modelo], period, deadline: shiftWeekend(deadline), required: required && calc.required !== false, ...calc,
      status: f ? f.status : null, filing: f || null });
  };
  const iva = profile.regimen_iva === 'general';
  for (const q of [1, 2, 3, 4]) {
    const P = `${q}T`;
    if (iva) add(303, P, QUARTER_DEADLINE(year, q), m303(entries, profile, year, q));
    if (profile.forma === 'autonomo' && !profile.exento_130) add(130, P, QUARTER_DEADLINE(year, q), m130(entries, profile, year, q));
    const r111 = m111(entries, year, q); add(111, P, QUARTER_DEADLINE(year, q), r111, { required: r111.required || profile.tiene_empleados });
    const r115 = m115(entries, year, q); add(115, P, QUARTER_DEADLINE(year, q), r115, { required: r115.required || profile.alquila_local });
  }
  if (profile.forma === 'sociedad') {
    const req = (Number(profile.is_ultima_cuota) || 0) > 0;
    add(202, '1P', `${year}-04-20`, m202(profile, '1P'), { required: req });
    add(202, '2P', `${year}-10-20`, m202(profile, '2P'), { required: req });
    add(202, '3P', `${year}-12-20`, m202(profile, '3P'), { required: req });
  }
  if (iva) add(390, '0A', `${year + 1}-01-30`, m390(entries, profile, year));
  const a190 = annualRet(entries, year, '111'); add(190, '0A', `${year + 1}-01-31`, a190, { required: a190.required || profile.tiene_empleados });
  const a180 = annualRet(entries, year, '115'); add(180, '0A', `${year + 1}-01-31`, a180, { required: a180.required || profile.alquila_local });
  add(347, '0A', `${year + 1}-02-${lastDayFeb(year + 1)}`, m347(entries, year));
  const ann = annualIncome(entries, profile, year);
  add(ann.modelo, '0A', ann.modelo === '200' ? `${year + 1}-07-25` : `${year + 1}-06-30`, ann);

  for (const o of out) {
    o.periodStart = o.period.endsWith('T') ? `${year}-${String((Number(o.period[0]) - 1) * 3 + 1).padStart(2, '0')}-01` : `${year}-01-01`;
    o.open = o.periodStart <= today;                                  // el periodo ya ha empezado
    o.overdue = !o.status && o.required && o.deadline < today;
    o.state = o.status ? o.status : !o.required ? 'no_aplica' : o.overdue ? 'vencido' : o.open ? 'pendiente' : 'futuro';
  }
  return out.sort((a, b) => a.deadline.localeCompare(b.deadline) || a.modelo.localeCompare(b.modelo));
}

// Cuánto dinero apartar: lo pendiente de presentar (con importe) + estimación anual
function reserve(cal, profile, today = new Date().toISOString().slice(0, 10)) {
  // Solo lo que aún se puede presentar: lo vencido sin marcar se muestra aparte (probablemente ya pagado)
  const items = cal.filter(o => o.required && o.open && !o.status && o.deadline >= today && typeof o.result === 'number' && o.result > 0 && !['200', '100'].includes(o.modelo))
    .map(o => ({ modelo: o.modelo, period: o.period, name: o.name, amount: o.result, deadline: o.deadline }));
  const ann = cal.find(o => ['200', '100'].includes(o.modelo));
  if (ann && ann.result > 0 && !ann.status && ann.deadline >= today) items.push({ modelo: ann.modelo, period: 'año', name: ann.name, amount: ann.result, deadline: ann.deadline, estimate: true });
  const overdue = cal.filter(o => o.overdue).length;
  return { total: r2(items.reduce((a, i) => a + i.amount, 0)), items, overdue };
}

function deducibilityReport(entries, profile, year, quarter) {
  const E = entries.filter(e => e.kind === 'gasto' && yearOf(e.date) === year && (!quarter || quarterOf(e.date) === quarter) && !e.incomplete);
  const rows = E.map(e => ({ ...e, ded: deductibility(e, profile) }));
  const t = {
    gastos: sum(rows, 'base'), gastoDeducible: sum(rows, r => r.ded.gastoDeducible),
    iva: sum(rows, 'iva'), ivaDeducible: sum(rows, r => r.ded.ivaDeducible),
    revisar: rows.filter(r => r.ded.estado === 'revisar' || r.ded.ivaEstado === 'revisar').length,
  };
  t.noDeducible = r2(t.gastos - t.gastoDeducible); t.ivaNoDeducible = r2(t.iva - t.ivaDeducible);
  return { totals: t, rows: rows.sort((a, b) => b.date.localeCompare(a.date)) };
}

module.exports = { DEFAULT_PROFILE, profileOf, cleanProfile, deductibility, calendar, reserve, deducibilityReport, MODELS, m303, m130, irpfEstimate, shiftWeekend };
