import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generarAdicionales, aCSV } from '../src/data/additional.js';
import { buildDataset, readProvided, prepareData } from '../src/data/prepare.js';

test('adicionales: los nueve CSV reproducen 20 filas por entidad y conservan las referencias', async () => {
  const directory = new URL('../data/adicionales/', import.meta.url);
  const { fecha_base } = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  const generated = generarAdicionales(fecha_base);
  for (const [name, rows] of Object.entries(generated)) {
    assert.equal(rows.length, 20);
    assert.equal(await readFile(new URL(`${name}.csv`, directory), 'utf8'), aCSV(rows));
  }
  const data = await buildDataset({ adicionales: true });
  assert.deepEqual(
    Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])),
    {
      clientes: 28,
      sucursales: 25,
      farmaceuticos: 27,
      proveedores: 25,
      productos: 33,
      stock_lotes: 38,
      recetas: 29,
      ventas: 36,
    },
  );
  assert.equal(
    data.ventas.reduce((n, v) => n + v.items.length, 0),
    42,
  );
  const originals = await buildDataset();
  for (const [name, rows] of Object.entries(originals)) {
    assert.deepEqual(data[name].slice(0, rows.length), rows);
  }
});

test('adicionales: las dispensas coinciden con las ventas completadas y la generación es determinista', async () => {
  const data = prepareData(await readProvided(new URL('../data/adicionales/', import.meta.url)));
  for (const receta of data.recetas) {
    const ventas = data.ventas.filter(
      (v) => v.id_receta === receta.id_receta && v.estado === 'Completada',
    );
    assert.equal(receta.dispensas_realizadas, ventas.length, receta.id_receta);
    assert.ok(ventas.every((v) => v.fecha >= receta.fecha_emision));
  }
  assert.deepEqual(generarAdicionales('2027-01-01'), generarAdicionales('2027-01-01'));
  assert.equal(
    generarAdicionales('2027-01-01').ventas[9].fecha.toISOString(),
    '2026-12-31T00:00:00.000Z',
  );
  assert.throws(() => generarAdicionales('2027-02-30'));
});
