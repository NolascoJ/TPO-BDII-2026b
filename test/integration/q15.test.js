import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { q15 } from '../../src/queries/q15.js';
import { diasDesdeHoy, enTransaccion, snapshot, insertarVenta, lote } from './ventas-helpers.js';

test('q15 con MongoDB real: FEFO, rechazos sin efectos, doble aplicación y concurrencia', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  try {
    await ensureSchema(db);
    await loadData(client, db);
    const stock = db.collection('stock_lotes');
    const vencimientos = { L001: 300, L005: 10, L006: 200, L009: 0, L015: 200, L017: 200 };
    for (const [idLote, dias] of Object.entries(vencimientos)) {
      await stock.updateOne({ id_lote: idLote }, { $set: { vencimiento: diasDesdeHoy(dias) } });
    }
    await stock.insertOne({
      id_lote: 'LT-VENCIDO',
      id_producto: 'PRD003',
      id_sucursal: 'S001',
      nro_lote: 'L-TEST',
      unidades: 500,
      vencimiento: diasDesdeHoy(-1),
      version: 1,
    });

    const rechazaSinEfectos = async (operacion, error) => {
      const antes = await snapshot(db);
      await assert.rejects(enTransaccion(client, operacion), error);
      assert.deepEqual(await snapshot(db), antes);
    };

    await t.test('exige una transacción activa', async () => {
      const antes = await snapshot(db);
      await assert.rejects(q15({ db }, { id_venta: 'V003' }), { code: 'TRANSACCION_REQUERIDA' });
      const session = client.startSession();
      try {
        await assert.rejects(q15({ db, session }, { id_venta: 'V003' }), {
          code: 'TRANSACCION_REQUERIDA',
        });
      } finally {
        await session.endSession();
      }
      assert.deepEqual(await snapshot(db), antes);
    });

    await t.test('rechaza parámetros inválidos', async () => {
      for (const params of [{}, { id_venta: '' }, { id_venta: 'V003', extra: 1 }, null]) {
        await rechazaSinEfectos((session) => q15({ db, session }, params), {
          code: 'PARAMETROS_INVALIDOS',
        });
      }
    });

    await t.test('rechaza ventas inexistentes, importadas y no completadas', async () => {
      await rechazaSinEfectos((session) => q15({ db, session }, { id_venta: 'NO-EXISTE' }), {
        code: 'VENTA_INVALIDA',
      });
      await rechazaSinEfectos((session) => q15({ db, session }, { id_venta: 'V003' }), {
        code: 'VENTA_INVALIDA',
        details: { id_venta: 'V003', origen: 'importacion' },
      });
      for (const estado of ['Pendiente', 'Anulada']) {
        await rechazaSinEfectos(
          async (session) => {
            await insertarVenta(db, session, `V-T-${estado}`, [['PRD001', 1]], { estado });
            return q15({ db, session }, { id_venta: `V-T-${estado}` });
          },
          { code: 'VENTA_INVALIDA', details: { id_venta: `V-T-${estado}`, estado } },
        );
      }
    });

    await t.test(
      'reparte entre lotes por FEFO y no toca vencidos ni otras sucursales',
      async () => {
        const intactos = ['LT-VENCIDO', 'L006', 'L017'];
        const antes = await Promise.all(intactos.map((id) => lote(db, id)));

        const resultado = await enTransaccion(client, async (session) => {
          await insertarVenta(db, session, 'V-T-FEFO', [['PRD003', 50]]);
          return q15({ db, session }, { id_venta: 'V-T-FEFO' });
        });

        assert.deepEqual(resultado, {
          id_venta: 'V-T-FEFO',
          id_sucursal: 'S001',
          movimientos: [
            { id_lote: 'L005', descontar: 40, id_producto: 'PRD003' },
            { id_lote: 'L015', descontar: 10, id_producto: 'PRD003' },
          ],
        });
        assert.equal((await lote(db, 'L005')).unidades, 0);
        assert.equal((await lote(db, 'L015')).unidades, 90);
        assert.equal((await lote(db, 'L015')).version, 2);
        assert.deepEqual(await Promise.all(intactos.map((id) => lote(db, id))), antes);
        const venta = await db.collection('ventas').findOne({ id_venta: 'V-T-FEFO' });
        assert.equal(venta.stock_aplicado, true);
      },
    );

    await t.test('un lote que vence hoy se puede dispensar', async () => {
      await enTransaccion(client, async (session) => {
        await insertarVenta(db, session, 'V-T-HOY', [['PRD006', 1]]);
        return q15({ db, session }, { id_venta: 'V-T-HOY' });
      });
      assert.equal((await lote(db, 'L009')).unidades, 59);
    });

    await t.test('no descuenta dos veces la misma venta', async () => {
      await rechazaSinEfectos((session) => q15({ db, session }, { id_venta: 'V-T-FEFO' }), {
        code: 'STOCK_YA_APLICADO',
      });
    });

    await t.test('si un ítem no alcanza, no queda ningún lote ni venta modificados', async () => {
      await rechazaSinEfectos(
        async (session) => {
          await insertarVenta(db, session, 'V-T-FALTA', [
            ['PRD001', 1],
            ['PRD006', 1000],
          ]);
          return q15({ db, session }, { id_venta: 'V-T-FALTA' });
        },
        {
          code: 'STOCK_INSUFICIENTE',
          details: { id_producto: 'PRD006', requerido: 1000, disponible: 59 },
        },
      );
    });

    await t.test('los lotes vencidos y los de otras sucursales no cuentan como stock', async () => {
      await rechazaSinEfectos(
        async (session) => {
          await insertarVenta(db, session, 'V-T-VENCIDO', [['PRD003', 91]]);
          return q15({ db, session }, { id_venta: 'V-T-VENCIDO' });
        },
        {
          code: 'STOCK_INSUFICIENTE',
          details: { id_producto: 'PRD003', requerido: 91, disponible: 90 },
        },
      );
      await rechazaSinEfectos(
        async (session) => {
          await insertarVenta(db, session, 'V-T-SUCURSAL', [['PRD004', 1]]);
          return q15({ db, session }, { id_venta: 'V-T-SUCURSAL' });
        },
        {
          code: 'STOCK_INSUFICIENTE',
          details: { id_producto: 'PRD004', requerido: 1, disponible: 0 },
        },
      );
    });

    await t.test('ventas concurrentes sobre el mismo lote no generan sobreventa', async () => {
      await stock.updateOne({ id_lote: 'L001' }, { $set: { unidades: 5 } });
      const resultados = await Promise.allSettled(
        Array.from({ length: 10 }, (_, indice) =>
          enTransaccion(client, async (session) => {
            await insertarVenta(db, session, `V-T-CONC-${indice}`, [['PRD001', 1]]);
            return q15({ db, session }, { id_venta: `V-T-CONC-${indice}` });
          }),
        ),
      );
      const exitos = resultados.filter((r) => r.status === 'fulfilled');
      const rechazos = resultados.filter((r) => r.status === 'rejected');
      assert.equal(exitos.length, 5);
      assert.ok(rechazos.every((r) => r.reason.code === 'STOCK_INSUFICIENTE'));
      assert.equal((await lote(db, 'L001')).unidades, 0);
      const ventas = await db
        .collection('ventas')
        .countDocuments({ id_venta: /^V-T-CONC-/, stock_aplicado: true });
      assert.equal(ventas, 5);
    });
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
