import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { q07 } from '../../src/queries/q07.js';
import { q11 } from '../../src/queries/q11.js';
import { snapshot } from './ventas-helpers.js';

// Estos documentos solo se insertan en bases temporales para ejercitar las agregaciones.
function ventaDePrueba(plantilla, idVenta, detalles, cambios = {}) {
  const items = detalles.map(([idProducto, cantidad, precioUnit], indice) => ({
    id_detalle: `${idVenta}-${indice + 1}`,
    id_producto: idProducto,
    cantidad,
    precio_unit: precioUnit,
  }));
  return {
    ...plantilla,
    ...cambios,
    id_venta: idVenta,
    stock_aplicado: (cambios.estado ?? plantilla.estado) === 'Completada',
    total: items.reduce((suma, item) => suma + item.cantidad * item.precio_unit, 0),
    items,
  };
}

test('q07 con MongoDB real: unidades, ranking y datos de productos', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  try {
    await ensureSchema(db);
    await t.test('sin ventas devuelve un arreglo vacío', async () => {
      assert.deepEqual(await q07({ db }), []);
    });

    await loadData(client, db);
    await t.test('dataset provisto: top 5 por unidades y producto completo', async () => {
      const antes = await snapshot(db);
      const resultado = await q07({ db });
      assert.deepEqual(
        resultado.map((r) => [r.id_producto, r.unidades_vendidas]),
        [
          ['PRD005', 6],
          ['PRD011', 5],
          ['PRD001', 4],
          ['PRD004', 3],
          ['PRD009', 2],
        ],
      );
      for (const fila of resultado) {
        assert.deepEqual(
          fila.producto,
          await db.collection('productos').findOne({ id_producto: fila.id_producto }),
        );
      }
      assert.deepEqual(await snapshot(db), antes);
    });

    const ventas = db.collection('ventas');
    const plantilla = await ventas.findOne({ id_venta: 'V013' }, { projection: { _id: 0 } });
    await ventas.updateMany({}, { $set: { estado: 'Anulada' } });
    await ventas.insertMany([
      ventaDePrueba(
        plantilla,
        'Q07-A',
        [
          ['PRD001', 2, 100],
          ['PRD002', 1, 10000],
          ['PRD003', 8, 1],
          ['PRD004', 7, 1],
        ],
        { fecha: new Date('2000-01-01T00:00:00Z') },
      ),
      ventaDePrueba(plantilla, 'Q07-B', [
        ['PRD001', 7, 100],
        ['PRD007', 6, 1],
        ['PRD006', 6, 1],
        ['PRD005', 6, 1],
      ]),
      ventaDePrueba(plantilla, 'Q07-C', [['PRD002', 1, 10000]]),
      ventaDePrueba(plantilla, 'Q07-PENDIENTE', [['PRD008', 1000, 1]], { estado: 'Pendiente' }),
      ventaDePrueba(plantilla, 'Q07-ANULADA', [['PRD009', 1000, 1]], { estado: 'Anulada' }),
    ]);
    await db
      .collection('productos')
      .updateOne({ id_producto: 'PRD001' }, { $set: { activo: false } });

    await t.test(
      'suma cantidades, excluye otros estados y desempata el quinto puesto por ID',
      async () => {
        const antes = await snapshot(db);
        const resultado = await q07({ db });
        assert.deepEqual(
          resultado.map((r) => [r.id_producto, r.unidades_vendidas]),
          [
            ['PRD001', 9],
            ['PRD003', 8],
            ['PRD004', 7],
            ['PRD005', 6],
            ['PRD006', 6],
          ],
        );
        assert.equal(resultado[0].producto.activo, false);
        assert.deepEqual(await snapshot(db), antes);
      },
    );

    await t.test(
      'devuelve menos de cinco si hay pocos productos y vacío si no hay completadas',
      async () => {
        await ventas.updateOne({ id_venta: 'Q07-B' }, { $set: { estado: 'Anulada' } });
        assert.deepEqual(
          (await q07({ db })).map((r) => [r.id_producto, r.unidades_vendidas]),
          [
            ['PRD003', 8],
            ['PRD004', 7],
            ['PRD001', 2],
            ['PRD002', 2],
          ],
        );
        await ventas.updateMany({}, { $set: { estado: 'Anulada' } });
        assert.deepEqual(await q07({ db }), []);
      },
    );
  } finally {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  }
});

test('q11 con MongoDB real: ingresos históricos y mes UTC', async (t) => {
  const zonaOriginal = process.env.TZ;
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  try {
    process.env.TZ = 'America/Argentina/Buenos_Aires';
    await ensureSchema(db);
    await t.test('sin ventas devuelve un arreglo vacío', async () => {
      assert.deepEqual(await q11({ db }), []);
    });

    await loadData(client, db);
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
    await t.test('dataset provisto: ingresos de octubre y profesional completo', async () => {
      const antes = await snapshot(db);
      const resultado = await q11({ db });
      assert.deepEqual(
        resultado.map((r) => [r.id_farmaceutico, r.ingresos_totales]),
        [
          ['F002', 7800],
          ['F003', 7100],
          ['F005', 4600],
          ['F001', 4400],
        ],
      );
      for (const fila of resultado) {
        assert.deepEqual(
          fila.farmaceutico,
          await db.collection('farmaceuticos').findOne({ id_farmaceutico: fila.id_farmaceutico }),
        );
      }
      assert.deepEqual(await snapshot(db), antes);
    });

    const ventas = db.collection('ventas');
    const plantilla = await ventas.findOne({ id_venta: 'V013' }, { projection: { _id: 0 } });
    await ventas.updateMany({}, { $set: { estado: 'Anulada' } });
    await ventas.insertMany([
      ventaDePrueba(plantilla, 'Q11-ANTES', [['PRD001', 1, 100000]], {
        fecha: new Date('2026-11-30T23:59:59.999Z'),
      }),
      ventaDePrueba(
        plantilla,
        'Q11-INICIO',
        [
          ['PRD001', 2, 200],
          ['PRD002', 3, 200],
        ],
        { fecha: new Date('2026-12-01T00:00:00Z') },
      ),
      ventaDePrueba(plantilla, 'Q11-FIN', [['PRD001', 1, 2000]], {
        fecha: new Date('2026-12-31T23:59:59.999Z'),
      }),
      ventaDePrueba(plantilla, 'Q11-SIGUIENTE', [['PRD001', 1, 4000]], {
        fecha: new Date('2027-01-01T00:00:00Z'),
      }),
      ventaDePrueba(plantilla, 'Q11-OTRO-ANIO', [['PRD001', 1, 100000]], {
        fecha: new Date('2025-12-15T00:00:00Z'),
      }),
      ventaDePrueba(plantilla, 'Q11-INACTIVO', [['PRD001', 1, 5000]], {
        fecha: new Date('2026-12-15T12:00:00Z'),
        id_farmaceutico: 'F004',
        id_sucursal: 'S002',
      }),
      ventaDePrueba(plantilla, 'Q11-EMPATE', [['PRD001', 1, 3000]], {
        fecha: new Date('2026-12-15T12:00:00Z'),
        id_farmaceutico: 'F002',
      }),
      ventaDePrueba(plantilla, 'Q11-CERO', [['PRD001', 1, 0]], {
        fecha: new Date('2026-12-15T12:00:00Z'),
        id_farmaceutico: 'F003',
        id_sucursal: 'S002',
      }),
      ventaDePrueba(plantilla, 'Q11-PENDIENTE', [['PRD001', 1, 100000]], {
        fecha: new Date('2026-12-15T12:00:00Z'),
        estado: 'Pendiente',
      }),
      ventaDePrueba(plantilla, 'Q11-ANULADA', [['PRD001', 1, 100000]], {
        fecha: new Date('2026-12-15T12:00:00Z'),
        estado: 'Anulada',
      }),
    ]);
    // Coincidir en nombre no debe fusionar los ingresos de dos profesionales distintos.
    const profesional = await db.collection('farmaceuticos').findOne({ id_farmaceutico: 'F001' });
    await db.collection('farmaceuticos').updateOne(
      { id_farmaceutico: 'F002' },
      {
        $set: { nombre: profesional.nombre, apellido: profesional.apellido },
      },
    );
    // En Buenos Aires sigue siendo noviembre; el mes de la consulta debe ser diciembre UTC.
    t.mock.timers.setTime(Date.parse('2026-12-01T01:30:00Z'));
    const esperadas = [
      ['F004', 5000],
      ['F001', 3000],
      ['F002', 3000],
      ['F003', 0],
    ];

    await t.test(
      'límites del mes, estados, inactivos, empates y varias líneas por venta',
      async () => {
        const antes = await snapshot(db);
        const resultado = await q11({ db });
        assert.deepEqual(
          resultado.map((r) => [r.id_farmaceutico, r.ingresos_totales]),
          esperadas,
        );
        assert.equal(resultado[0].farmaceutico.activo, false);
        assert.deepEqual(await snapshot(db), antes);
      },
    );

    await t.test('cambiar precios del catálogo no altera los ingresos históricos', async () => {
      const antes = await q11({ db });
      await db.collection('productos').updateMany({}, { $set: { precio_unit: 999999 } });
      assert.deepEqual(await q11({ db }), antes);
    });

    await t.test(
      'recalcula el período al cambiar de mes y año; un mes sin ventas queda vacío',
      async () => {
        t.mock.timers.setTime(Date.parse('2026-12-31T23:59:59.999Z'));
        assert.deepEqual(
          (await q11({ db })).map((r) => [r.id_farmaceutico, r.ingresos_totales]),
          esperadas,
        );
        t.mock.timers.setTime(Date.parse('2027-01-01T00:00:00Z'));
        assert.deepEqual(
          (await q11({ db })).map((r) => [r.id_farmaceutico, r.ingresos_totales]),
          [['F001', 4000]],
        );
        t.mock.timers.setTime(Date.parse('2027-02-01T00:00:00Z'));
        assert.deepEqual(await q11({ db }), []);
      },
    );
  } finally {
    t.mock.timers.reset();
    if (zonaOriginal === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = zonaOriginal;
    }
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  }
});
