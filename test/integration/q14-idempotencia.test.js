import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { q14 } from '../../src/queries/q14.js';
import { diasDesdeHoy, snapshot, estadoInicial, assertInvariantes } from './ventas-helpers.js';

test('q14 idempotente: reintentos, conflictos de id_venta y pedidos repetidos concurrentes', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  const contexto = { client, db };
  try {
    await ensureSchema(db);
    await loadData(client, db);
    for (const [idLote, dias] of Object.entries({ L001: 300, L005: 10, L015: 200 })) {
      await db
        .collection('stock_lotes')
        .updateOne({ id_lote: idLote }, { $set: { vencimiento: diasDesdeHoy(dias) } });
    }
    const inicial = await estadoInicial(db);
    const receta = (idReceta) =>
      db.collection('recetas').findOne({ id_receta: idReceta }, { projection: { _id: 0 } });
    const unidadesPRD003EnS001 = async () =>
      (
        await db
          .collection('stock_lotes')
          .find({ id_producto: 'PRD003', id_sucursal: 'S001' })
          .toArray()
      ).reduce((suma, l) => suma + l.unidades, 0);
    const pedido = (idVenta, cambios = {}) => ({
      id_venta: idVenta,
      id_cliente: 'C005',
      id_farmaceutico: 'F001',
      medio_pago: 'Efectivo',
      items: [{ id_producto: 'PRD001', cantidad: 2 }],
      ...cambios,
    });

    await t.test('repetir el mismo pedido devuelve la venta sin nuevos efectos', async () => {
      const primera = await q14(contexto, pedido('V-T14-I1'));
      assert.equal(primera.ya_registrada, false);
      const antes = await snapshot(db);
      const segunda = await q14(contexto, pedido('V-T14-I1'));
      assert.equal(segunda.ya_registrada, true);
      assert.deepEqual(segunda.venta, primera.venta);
      assert.deepEqual(segunda.movimientos, []);
      assert.deepEqual(await snapshot(db), antes);
    });

    await t.test('el mismo id_venta con otro contenido es un conflicto sin efectos', async () => {
      const antes = await snapshot(db);
      await assert.rejects(
        q14(contexto, pedido('V-T14-I1', { items: [{ id_producto: 'PRD001', cantidad: 3 }] })),
        { code: 'CONFLICTO_IDEMPOTENCIA', details: { id_venta: 'V-T14-I1', campos: ['items'] } },
      );
      await assert.rejects(q14(contexto, pedido('V001')), {
        code: 'CONFLICTO_IDEMPOTENCIA',
        details: { id_venta: 'V001', origen: 'importacion' },
      });
      assert.deepEqual(await snapshot(db), antes);
    });

    await t.test(
      'un reintento con receta ignorada se reconoce con la misma advertencia',
      async () => {
        const conReceta = pedido('V-T14-I6', { id_cliente: 'C006', id_receta: 'RC004' });
        const primera = await q14(contexto, conReceta);
        const antes = await snapshot(db);
        const segunda = await q14(contexto, conReceta);
        assert.equal(segunda.ya_registrada, true);
        assert.deepEqual(segunda.advertencias, primera.advertencias);
        assert.equal(segunda.advertencias.length, 1);
        assert.deepEqual(await snapshot(db), antes);
      },
    );

    await t.test('pedidos idénticos concurrentes registran una sola venta y dispensa', async () => {
      const unidadesAntes = await unidadesPRD003EnS001();
      const conReceta = pedido('V-T14-C3', {
        id_cliente: 'C003',
        id_receta: 'RC002',
        medio_pago: 'Obra social',
        items: [{ id_producto: 'PRD003', cantidad: 1 }],
      });
      const resultados = await Promise.all(
        Array.from({ length: 5 }, () => q14(contexto, conReceta)),
      );
      assert.equal(resultados.filter((r) => !r.ya_registrada).length, 1);
      assert.equal(resultados.filter((r) => r.ya_registrada).length, 4);
      assert.equal(await db.collection('ventas').countDocuments({ id_venta: 'V-T14-C3' }), 1);
      assert.equal(await unidadesPRD003EnS001(), unidadesAntes - 1);
      const actualizada = await receta('RC002');
      assert.equal(actualizada.dispensas_realizadas, 3);
      assert.equal(actualizada.version, 2);
      assert.equal(await db.collection('outbox').countDocuments({ id_entidad: 'V-T14-C3' }), 1);
      assert.equal(await db.collection('outbox').countDocuments({ id_entidad: 'RC002' }), 1);
    });

    await t.test('ventas concurrentes con la misma receta respetan las dispensas', async () => {
      // RC004 está en 1/3: dos ventas pueden dispensar y la tercera debe rechazarse
      const unidadesAntes = await unidadesPRD003EnS001();
      const resultados = await Promise.allSettled(
        Array.from({ length: 3 }, (_, indice) =>
          q14(
            contexto,
            pedido(`V-T14-C2-${indice}`, {
              id_cliente: 'C006',
              id_receta: 'RC004',
              medio_pago: 'Obra social',
              items: [{ id_producto: 'PRD003', cantidad: 1 }],
            }),
          ),
        ),
      );
      const exitos = resultados.filter((r) => r.status === 'fulfilled');
      const rechazos = resultados.filter((r) => r.status === 'rejected');
      assert.equal(exitos.length, 2);
      assert.equal(rechazos.length, 1);
      assert.equal(rechazos[0].reason.code, 'RECETA_INVALIDA');
      const actualizada = await receta('RC004');
      assert.equal(actualizada.dispensas_realizadas, 3);
      assert.equal(actualizada.estado, 'Completada');
      assert.equal(actualizada.proxima_dispensa, null);
      assert.equal(actualizada.version, 3);
      assert.equal(await unidadesPRD003EnS001(), unidadesAntes - 2);
      const versiones = (
        await db
          .collection('outbox')
          .find({ tipo_entidad: 'receta', id_entidad: 'RC004' })
          .sort({ version: 1 })
          .toArray()
      ).map((evento) => evento.version);
      assert.deepEqual(versiones, [2, 3]);
    });

    await t.test('se cumplen los invariantes después de todas las operaciones', () =>
      assertInvariantes(db, inicial),
    );
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
