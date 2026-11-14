import test from 'node:test';
import assert from 'node:assert/strict';
import { readProvided, prepareData, convertRow } from '../src/data/prepare.js';

test('CSV: conserva strings, nulos, booleanos, importes y fechas; embeber no aplica efectos', async () => {
  const provided = await readProvided();
  assert.equal(provided.clientes[0].dni, '31245678');
  assert.equal(provided.clientes[0].activo, true);
  assert.equal(provided.ventas[1].id_receta, null);
  assert.equal(provided.recetas[0].proxima_dispensa, null);

  const data = prepareData(provided);
  assert.equal(data.clientes.length, 8);
  assert.equal(data.stock_lotes.length, 18);
  assert.equal(data.ventas.length, 16);
  assert.equal(
    data.ventas.reduce((sum, row) => sum + row.items.length, 0),
    22,
  );
  assert.equal(data.ventas.find((sale) => sale.id_venta === 'V001').id_sucursal, 'S002');
  assert.equal(data.ventas.find((sale) => sale.id_venta === 'V003').stock_aplicado, true);
  assert.equal(data.ventas.find((sale) => sale.id_venta === 'V011').stock_aplicado, false);
  assert.equal(data.stock_lotes[0].unidades, 120);
  assert.equal(data.recetas[0].dispensas_realizadas, 1);
  assert.equal(data.ventas[0].fecha.toISOString(), '2025-09-18T00:00:00.000Z');
});

test('La conversión rechaza booleanos, fechas inexistentes, negativos y encabezados incorrectos', async () => {
  const data = await readProvided();
  for (const value of ['true', 'Sí', null]) {
    assert.throws(() => convertRow('clientes', { ...data.clientes[0], activo: value }));
  }
  assert.throws(() =>
    convertRow('stock_lotes', { ...data.stock_lotes[0], vencimiento: '2026-02-30' }),
  );
  assert.throws(() => convertRow('stock_lotes', { ...data.stock_lotes[0], unidades: '-1' }));
  assert.throws(() => convertRow('stock_lotes', { ...data.stock_lotes[0], unidades: '1.5' }));
  assert.throws(() => convertRow('clientes', { ...data.clientes[0], typo: 'extra' }));
});

test('Valida IDs, DNI, referencias y totales antes de escribir', async () => {
  const provided = await readProvided();
  const scenarios = [
    (data) => {
      data.clientes[1].id_cliente = data.clientes[0].id_cliente;
    },
    (data) => {
      data.clientes[1].dni = data.clientes[0].dni;
    },
    (data) => {
      data.productos[0].id_proveedor = 'NO-EXISTE';
    },
    (data) => {
      data.ventas[0].total++;
    },
    (data) => {
      data.detalle_ventas[0].id_venta = 'NO-EXISTE';
    },
    (data) => {
      data.clientes.shift();
    },
    (data) => {
      data.ventas[0].id_farmaceutico = 'F007';
    },
    (data) => {
      data.recetas[0].dispensas_realizadas = 4;
    },
  ];

  for (const mutate of scenarios) {
    const data = structuredClone(provided);
    mutate(data);
    assert.throws(() => prepareData(data), { code: 'DATOS_INVALIDOS' });
  }
});

test('La preparación es reproducible y no modifica los registros de origen', async () => {
  const provided = await readProvided();
  const original = structuredClone(provided);
  assert.deepEqual(prepareData(provided), prepareData(provided));
  assert.deepEqual(provided, original);
});
