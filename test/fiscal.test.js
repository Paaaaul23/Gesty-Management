'use strict';
// Pruebas de los cálculos fiscales con un caso comprobado a mano.  Uso: npm test
process.env.GESTY_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fis = require('../fiscal');

const E = [
  { source: 'doc', kind: 'ingreso', date: '2025-02-10', base: 1000, iva: 210, recargo: 0, retencion: 150, total: 1060, category: 'servicios', tercero: 'Cliente A', nif: 'B11111111', ivaRate: 21 },
  { source: 'doc', kind: 'ingreso', date: '2025-05-10', base: 5000, iva: 1050, recargo: 0, retencion: 0, total: 6050, category: 'ventas', tercero: 'Cliente B', nif: 'B22222222', ivaRate: 21 },
  { source: 'doc', kind: 'gasto', date: '2025-02-15', base: 200, iva: 42, recargo: 0, retencion: 0, total: 242, category: 'compras', tercero: 'Prov', nif: 'B33333333', ivaRate: 21 },
  { source: 'doc', kind: 'gasto', date: '2025-02-20', base: 50, iva: 10.5, recargo: 0, retencion: 0, total: 60.5, category: 'vehiculo', tercero: 'Gasolinera', ivaRate: 21 },
  { source: 'doc', kind: 'gasto', date: '2025-03-01', base: 30, iva: 3, recargo: 0, retencion: 0, total: 33, category: 'viajes', tercero: 'Bar', ivaRate: 10, simplificada: true, recipientOk: false },
  { source: 'doc', kind: 'gasto', date: '2025-03-05', base: 400, iva: 84, recargo: 0, retencion: 76, total: 408, category: 'alquiler', tercero: 'Casero', nif: '12345678Z', ivaRate: 21 },
  { source: 'manual', kind: 'gasto', date: '2025-03-31', base: 1500, iva: 0, recargo: 0, retencion: 180, total: 1320, category: 'personal', concepto: 'Nómina', tercero: 'Empleado' },
  { source: 'doc', kind: 'gasto', date: '2025-03-10', base: 100, iva: 0, recargo: 0, retencion: 0, total: 100, category: 'multas', tercero: 'DGT' },
];
const AUTO = { ...fis.DEFAULT_PROFILE, forma: 'autonomo' };
const cas = (m, k) => m.casillas.find(c => c[0] === k)[2];

test('303: IVA del vehículo al 50 % y ticket sin datos no deducible', () => {
  const m = fis.m303(E, AUTO, 2025, 1);
  assert.equal(cas(m, '09'), 210);
  assert.equal(cas(m, '28'), 625);       // 200 + 50 × 50 % + 400
  assert.equal(cas(m, '29'), 131.25);    // 42 + 5,25 + 84
  assert.equal(m.result, 78.75);
});

test('130: difícil justificación del 5 % y retenciones soportadas', () => {
  assert.equal(fis.m130(E, AUTO, 2025, 1).result, 0);       // rendimiento negativo
  const m = fis.m130(E, AUTO, 2025, 2);
  assert.equal(cas(m, '01'), 6000);
  assert.equal(cas(m, '02'), 2323.5);    // 2.130 deducibles + 5 % de 3.870
  assert.equal(cas(m, '04'), 735.3);
  assert.equal(m.result, 585.3);          // 735,30 − 150 de retenciones
});

test('Deducibilidad: multas y vehículo de autónomo', () => {
  const multa = fis.deductibility(E[7], AUTO);
  assert.equal(multa.estado, 'no');
  const coche = fis.deductibility(E[3], AUTO);
  assert.equal(coche.ivaDeducible, 5.25);
  assert.equal(coche.estado, 'revisar');
  const cocheSL = fis.deductibility(E[3], { ...AUTO, forma: 'sociedad' });
  assert.equal(cocheSL.gastoDeducible, 50);
});

test('Calendario: plazos que caen en fin de semana pasan al lunes', () => {
  const cal = fis.calendar(E, AUTO, 2025, [], '2025-06-01');
  assert.equal(cal.find(o => o.modelo === '303' && o.period === '1T').deadline, '2025-04-21');
  assert.equal(cal.find(o => o.modelo === '347').deadline, '2026-03-02');
  assert.equal(cal.find(o => o.modelo === '111' && o.period === '1T').result, 180);
  assert.equal(cal.find(o => o.modelo === '115' && o.period === '1T').result, 76);
});

test('Reserva: solo lo que vence a partir de hoy', () => {
  const cal = fis.calendar(E, AUTO, 2025, [], '2025-06-01');
  const r = fis.reserve(cal, AUTO, '2025-06-01');
  assert.deepEqual(r.items.map(i => `${i.modelo} ${i.period}`).sort(), ['130 2T', '303 2T']);
  assert.equal(r.total, 1635.3);
});
