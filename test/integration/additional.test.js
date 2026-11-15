import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { config } from '../../src/config.js';
import { connectMongo } from '../../src/db/connections.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { randomUUID } from 'node:crypto';
import { q13 } from '../../src/queries/q13.js';
import { conDemo, snapshotMongo } from '../../scripts/lib/demo.js';
import { recorrerDatos } from '../../scripts/lib/recorrido-datos.js';

test('carga completa: idempotencia y conservación de cambios posteriores', async () => {
  const { client, db } = await connectMongo({
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  });
  try {
    await ensureSchema(db);
    const primera = await loadData(client, db, { adicionales: true });
    assert.equal(primera.colecciones.ventas.insertados, 36);
    const antes = await snapshotMongo(db);
    const segunda = await loadData(client, db, { adicionales: true });
    assert.ok(Object.values(segunda.colecciones).every((c) => c.insertados === 0));
    assert.equal(await snapshotMongo(db), antes);
    await q13({ client, db }, { accion: 'baja', id_cliente: 'AD-C001' });
    await db
      .collection('stock_lotes')
      .updateOne({ id_lote: 'AD-L003' }, { $inc: { unidades: -1, version: 1 } });
    const cambiado = await snapshotMongo(db);
    await loadData(client, db, { adicionales: true });
    assert.equal(await snapshotMongo(db), cambiado);
  } finally {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  }
});

test('datos adicionales: las quince consultas, FEFO y sincronización con motores reales', async (t) => {
  const { fecha_base } = JSON.parse(
    await readFile(new URL('../../data/adicionales/manifest.json', import.meta.url), 'utf8'),
  );
  t.mock.timers.enable({ apis: ['Date'], now: new Date(`${fecha_base}T12:00:00Z`) });
  try {
    await conDemo({ grafo: true, adicionales: true }, async (ctx) => {
      const { id, cargaGrafo } = ctx;
      assert.equal(cargaGrafo.entidades.ventas.fuente, 36);
      assert.equal(cargaGrafo.entidades.clientes.fuente, 28);
      const r = await recorrerDatos(ctx);
      const l = r.lecturas;
      assert.equal(Object.keys(l).length, 12);
      assert.equal(l.q01.find((p) => p.id_producto === id('AD-P001')).proveedor.activo, false);
      assert.ok(l.q02.some((v) => v.id_venta === id('AD-V015')));
      assert.equal(l.q03.historial.filter((e) => e.id_venta?.includes('AD-')).length, 3);
      assert.equal(l.q04.find((c) => c.id_cliente === id('AD-C004')).cantidad_recetas, 2);
      assert.equal(l.q05.farmaceuticos.find((f) => f.id_farmaceutico === id('AD-F006')).ventas, 0);
      assert.deepEqual(
        l.q06.filter((r) => r.id_receta.includes('AD-')).map((r) => r.id_receta),
        [7, 6, 5, 4].map((n) => id(`AD-R00${n}`)),
      );
      assert.deepEqual(
        l.q07.map((p) => [p.id_producto, p.unidades_vendidas]),
        [
          [4, 20],
          [9, 13],
          [7, 10],
          [14, 9],
          [13, 8],
        ].map(([n, c]) => [id(`AD-P${String(n).padStart(3, '0')}`), c]),
      );
      assert.ok(l.q08.some((l) => l.id_lote === id('AD-L007')));
      assert.ok(!l.q08.some((l) => l.id_lote === id('AD-L010')));
      assert.deepEqual(
        l.q09
          .filter((v) => v.id_venta.includes('AD-'))
          .map((v) => v.id_venta)
          .sort(),
        [1, 15, 18].map((n) => id(`AD-V${String(n).padStart(3, '0')}`)).sort(),
      );
      assert.ok(l.q10.clientes.some((c) => c.id_cliente === id('AD-C004')));
      assert.equal(l.q11.find((f) => f.id_farmaceutico === id('AD-F001')).ingresos_totales, 11999);
      assert.ok(l.q12.clientes.some((c) => c.id_cliente === id('AD-C014') && c.nunca_compro));
      assert.ok(l.q12.clientes.some((c) => c.id_cliente === id('AD-C010') && !c.nunca_compro));
      assert.deepEqual(
        r.q14.movimientos.map((m) => [m.id_lote, m.descontar]),
        [
          [id('AD-L002'), 3],
          [id('AD-L003'), 2],
        ],
      );
      assert.equal(l.q05.farmaceuticos.find((f) => f.id_farmaceutico === id('AD-F007')).ventas, 0);
      assert.equal(l.q11.find((f) => f.id_farmaceutico === id('AD-F019')).ingresos_totales, 1000);
      assert.equal(r.sincronizacion.procesados, 3);
    });
  } finally {
    t.mock.timers.reset();
  }
});
