import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { q01 } from '../../src/queries/q01.js';
import { q02 } from '../../src/queries/q02.js';
import { q08 } from '../../src/queries/q08.js';

test('MongoDB real: carga idempotente, índices, validadores, transacciones y relaciones', async (t) => {
  // Cada prueba corre en una base temporal para no tocar los datos de trabajo
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  try {
    await ensureSchema(db);
    await ensureSchema(db);
    const first = await loadData(client, db);
    const dump = async () => {
      const result = {};
      for (const name of Object.keys(first.colecciones)) {
        result[name] = await db.collection(name).find().sort({ _id: 1 }).toArray();
      }
      return result;
    };
    const before = await dump();
    const second = await loadData(client, db);
    assert.deepEqual(await dump(), before);
    assert.ok(Object.values(second.colecciones).every((value) => value.insertados === 0));
    await t.test('Reejecutar conserva cambios de stock, recetas, precios y bajas', async () => {
      await db.collection('stock_lotes').updateOne({ id_lote: 'L001' }, { $inc: { unidades: -5 } });
      await db
        .collection('recetas')
        .updateOne(
          { id_receta: 'RC002' },
          { $set: { dispensas_realizadas: 3, estado: 'Completada', proxima_dispensa: null } },
        );
      await db
        .collection('clientes')
        .updateOne({ id_cliente: 'C001' }, { $set: { activo: false } });
      await db
        .collection('productos')
        .updateOne({ id_producto: 'PRD001' }, { $set: { precio_unit: 99999 } });
      const changed = await dump();
      await loadData(client, db);
      assert.deepEqual(await dump(), changed);
    });
    await t.test('DNI incluso en bajas, matrícula e IDs únicos; stock no negativo', async () => {
      const clone = async (name, filter) => {
        const { _id, ...row } = await db.collection(name).findOne(filter);
        return row;
      };
      await assert.rejects(
        db
          .collection('clientes')
          .insertOne({ ...(await clone('clientes', { id_cliente: 'C001' })), id_cliente: 'C-DUP' }),
        { code: 11000 },
      );
      await assert.rejects(
        db.collection('farmaceuticos').insertOne({
          ...(await clone('farmaceuticos', { id_farmaceutico: 'F001' })),
          id_farmaceutico: 'F-DUP',
        }),
        { code: 11000 },
      );
      await assert.rejects(
        db.collection('stock_lotes').updateOne({ id_lote: 'L001' }, { $set: { unidades: -1 } }),
        { code: 121 },
      );
      await assert.rejects(
        db.collection('clientes').updateOne({ id_cliente: 'C001' }, { $set: { activo: 'False' } }),
        { code: 121 },
      );
    });
    await t.test(
      'q01 solo filtra productos activos e incluye proveedor inactivo completo',
      async () => {
        await db
          .collection('proveedores')
          .updateOne({ id_proveedor: 'PRV001' }, { $set: { activo: false } });
        const rows = await q01({ db });
        assert.ok(rows.every((row) => row.activo && row.proveedor?.cuit));
        assert.equal(rows.find((row) => row.id_producto === 'PRD001').proveedor.activo, false);
      },
    );
    await t.test(
      'q02 no excluye profesionales inactivos y conserva sucursal histórica',
      async () => {
        await db
          .collection('farmaceuticos')
          .updateOne({ id_farmaceutico: 'F005' }, { $set: { activo: false, id_sucursal: 'S001' } });
        const rows = await q02({ db });
        assert.equal(rows.length, 2);
        assert.ok(
          rows.every(
            (row) =>
              row.estado === 'Pendiente' && row.farmaceutico.matricula && row.sucursal.nombre,
          ),
        );
        const row = rows.find((row) => row.id_venta === 'V012');
        assert.equal(row.farmaceutico.activo, false);
        assert.equal(row.sucursal.id_sucursal, 'S003');
      },
    );
    await t.test(
      'q08 incluye cero/vencidos; excluye exactamente 50; trae las tres relaciones',
      async () => {
        // Armamos estos casos límite solo en la base de prueba
        await db
          .collection('stock_lotes')
          .updateOne(
            { id_lote: 'L001' },
            { $set: { unidades: 0, vencimiento: new Date('2000-01-01T00:00:00Z') } },
          );
        await db
          .collection('stock_lotes')
          .updateOne({ id_lote: 'L002' }, { $set: { unidades: 50 } });
        const rows = await q08({ db });
        assert.ok(
          rows.every((row) => row.unidades < 50 && row.producto && row.sucursal && row.proveedor),
        );
        assert.ok(rows.some((row) => row.id_lote === 'L001' && row.unidades === 0));
        assert.ok(!rows.some((row) => row.id_lote === 'L002'));
      },
    );
    await t.test('Una falla aborta todos los cambios de una transacción', async () => {
      await db.collection('stock_lotes').updateOne({ id_lote: 'L001' }, { $set: { unidades: 10 } });
      const original = await db.collection('stock_lotes').findOne({ id_lote: 'L001' });
      const session = client.startSession();
      try {
        await assert.rejects(
          session.withTransaction(async () => {
            await db
              .collection('stock_lotes')
              .updateOne({ id_lote: 'L001' }, { $inc: { unidades: -1 } }, { session });
            await db
              .collection('stock_lotes')
              .updateOne({ id_lote: 'L002' }, { $set: { unidades: -1 } }, { session });
          }),
          { code: 121 },
        );
      } finally {
        await session.endSession();
      }
      assert.deepEqual(await db.collection('stock_lotes').findOne({ id_lote: 'L001' }), original);
    });
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
