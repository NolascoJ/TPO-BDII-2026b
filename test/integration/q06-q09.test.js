import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { q06 } from '../../src/queries/q06.js';
import { q09 } from '../../src/queries/q09.js';

test('q06 con MongoDB real: fechas UTC, estados y datos del cliente', async (t) => {
  const zonaOriginal = process.env.TZ;
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  try {
    // Zona local distinta de UTC para probar el corte del día.
    process.env.TZ = 'America/Argentina/Buenos_Aires';
    await ensureSchema(db);
    await loadData(client, db);
    // Simula Date sin alterar los timers del driver.
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-15T12:00:00Z') });
    await t.test(
      'dataset provisto: devuelve las recetas esperadas con el cliente completo',
      async () => {
        const recetas = await q06({ db });
        assert.deepEqual(
          recetas.map((r) => r.id_receta),
          ['RC002', 'RC003', 'RC004'],
        );
        assert.deepEqual(
          recetas[0].cliente,
          await db.collection('clientes').findOne({ id_cliente: recetas[0].id_cliente }),
        );
      },
    );

    const recetas = db.collection('recetas');
    const plantilla = await recetas.findOne({ id_receta: 'RC002' }, { projection: { _id: 0 } });
    await recetas.updateMany({}, { $set: { proxima_dispensa: null } });
    await db
      .collection('clientes')
      .updateOne({ id_cliente: plantilla.id_cliente }, { $set: { activo: false } });
    // En Buenos Aires todavía es 31/01: usar medianoche local excluiría casos válidos.
    t.mock.timers.setTime(Date.parse('2027-02-01T01:30:00Z'));

    const ayer = new Date('2027-01-31T23:59:59.999Z');
    const casos = [
      { id_receta: 'Q06-B', proxima_dispensa: ayer },
      { id_receta: 'Q06-A', proxima_dispensa: ayer },
      { id_receta: 'Q06-ANTERIOR', proxima_dispensa: new Date('2027-01-30T00:00:00Z') },
      { id_receta: 'Q06-HOY-INICIO', proxima_dispensa: new Date('2027-02-01T00:00:00Z') },
      { id_receta: 'Q06-HOY-TARDE', proxima_dispensa: new Date('2027-02-01T12:00:00Z') },
      { id_receta: 'Q06-FUTURA', proxima_dispensa: new Date('2027-02-02T00:00:00Z') },
      { id_receta: 'Q06-NULA', proxima_dispensa: null },
      { id_receta: 'Q06-SIMPLE', proxima_dispensa: ayer, tipo: 'Simple', dispensas_autorizadas: 1 },
      {
        id_receta: 'Q06-ARCHIVADA',
        proxima_dispensa: ayer,
        tipo: 'Archivada',
        dispensas_autorizadas: 1,
      },
      {
        // Fecha pasada para aislar el filtro de estado.
        id_receta: 'Q06-COMPLETADA',
        proxima_dispensa: ayer,
        estado: 'Completada',
        dispensas_realizadas: 3,
      },
      { id_receta: 'Q06-VENCIDA', proxima_dispensa: ayer, estado: 'Vencida' },
    ];
    await recetas.insertMany(
      casos.map((caso) => ({ ...plantilla, dispensas_realizadas: 0, ...caso })),
    );
    const esperadas = ['Q06-ANTERIOR', 'Q06-A', 'Q06-B'];

    await t.test(
      'filtra tipo, estado y fecha; incluye clientes inactivos y ordena empates por ID',
      async () => {
        const resultado = await q06({ db });
        assert.deepEqual(
          resultado.map((r) => r.id_receta),
          esperadas,
        );
        assert.ok(resultado.every((r) => r.cliente.id_cliente === plantilla.id_cliente));
        assert.ok(resultado.every((r) => r.cliente.activo === false));
        // Al cambiar el día, las dispensas de hoy pasan a estar atrasadas.
        t.mock.timers.setTime(Date.parse('2027-02-02T00:00:00Z'));
        assert.deepEqual(
          (await q06({ db })).map((r) => r.id_receta),
          [...esperadas, 'Q06-HOY-INICIO', 'Q06-HOY-TARDE'],
        );
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

test('q09 con MongoDB real: tipo de venta, límite de importe y estados', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  try {
    await ensureSchema(db);
    await loadData(client, db);
    await t.test('dataset provisto: devuelve V013 y V014 con sus ítems', async () => {
      const resultado = await q09({ db });
      assert.deepEqual(
        resultado.map((v) => [v.id_venta, v.total]),
        [
          ['V013', 4400],
          ['V014', 4600],
        ],
      );
      assert.deepEqual(
        resultado[0].items,
        (await db.collection('ventas').findOne({ id_venta: 'V013' })).items,
      );
    });

    const ventas = db.collection('ventas');
    const plantilla = await ventas.findOne({ id_venta: 'V013' }, { projection: { _id: 0 } });
    await ventas.updateMany({}, { $set: { estado: 'Anulada' } });
    const casos = [
      { id_venta: 'Q09-B', total: 4999, estado: 'Pendiente' },
      { id_venta: 'Q09-A', total: 1 },
      { id_venta: 'Q09-ANTERIOR', total: 0, fecha: new Date('2000-01-01T00:00:00Z') },
      { id_venta: 'Q09-LIMITE', total: 5000 },
      { id_venta: 'Q09-SUPERIOR', total: 5001 },
      { id_venta: 'Q09-ANULADA', total: 4999, estado: 'Anulada' },
      {
        id_venta: 'Q09-RECETA',
        total: 4999,
        tipo: 'Con receta',
        id_receta: 'RC001',
        id_cliente: 'C001',
      },
    ];
    await ventas.insertMany(
      casos.map((caso) => ({
        ...plantilla,
        fecha: new Date('2027-01-01T00:00:00Z'),
        ...caso,
        stock_aplicado: (caso.estado ?? plantilla.estado) === 'Completada',
        items: [
          {
            id_detalle: `${caso.id_venta}-01`,
            id_producto: plantilla.items[0].id_producto,
            cantidad: 1,
            precio_unit: caso.total,
          },
        ],
      })),
    );

    await t.test(
      'incluye pendientes y completadas; excluye anuladas, con receta y totales desde 5000',
      async () => {
        const resultado = await q09({ db });
        assert.deepEqual(
          resultado.map((v) => [v.id_venta, v.total, v.estado]),
          [
            ['Q09-ANTERIOR', 0, 'Completada'],
            ['Q09-A', 1, 'Completada'],
            ['Q09-B', 4999, 'Pendiente'],
          ],
        );
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
