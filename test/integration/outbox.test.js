import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { registrarEvento } from '../../src/outbox/registrar.js';
import { q14 } from '../../src/queries/q14.js';
import { diasDesdeHoy, enTransaccion, snapshot } from './ventas-helpers.js';

test('outbox con MongoDB real: atomicidad, unicidad e integración con q14', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  const outbox = db.collection('outbox');
  const clientes = db.collection('clientes');
  const eventoCliente = (contenido) => ({
    tipo_entidad: 'cliente',
    id_entidad: contenido.id_cliente,
    version: contenido.version,
    contenido,
  });
  try {
    await ensureSchema(db);
    await loadData(client, db);

    await t.test('una sesión real sin transacción no permite insertar eventos', async () => {
      const session = client.startSession();
      const antes = await snapshot(db);
      try {
        await assert.rejects(
          registrarEvento(
            db,
            session,
            eventoCliente(await clientes.findOne({ id_cliente: 'C001' })),
          ),
          { code: 'TRANSACCION_REQUERIDA' },
        );
        assert.deepEqual(await snapshot(db), antes);
      } finally {
        await session.endSession();
      }
    });

    await t.test('entidad y evento solo son visibles después de confirmar juntos', async () => {
      const original = await clientes.findOne({ id_cliente: 'C001' });
      let actualizada;
      await enTransaccion(client, async (session) => {
        actualizada = await clientes.findOneAndUpdate(
          { id_cliente: 'C001' },
          { $set: { email: 'outbox@example.test' }, $inc: { version: 1 } },
          { session, returnDocument: 'after' },
        );
        await registrarEvento(db, session, eventoCliente(actualizada));
        assert.ok(session.inTransaction());
        assert.equal(await outbox.countDocuments({}), 0);
        assert.deepEqual(await clientes.findOne({ id_cliente: 'C001' }), original);
        assert.equal(await outbox.countDocuments({}, { session }), 1);
      });
      const evento = await outbox.findOne({ id_evento: `cliente:C001:${actualizada.version}` });
      const { _id, ...contenido } = actualizada;
      assert.deepEqual(evento.contenido, contenido);
      assert.equal(evento.estado, 'Pendiente');
      assert.deepEqual(await clientes.findOne({ id_cliente: 'C001' }), actualizada);
    });

    await t.test('abortar después de insertar el evento revierte también la entidad', async () => {
      const antes = await snapshot(db);
      const fallo = new Error('Falla posterior al evento');
      await assert.rejects(
        enTransaccion(client, async (session) => {
          const contenido = await clientes.findOneAndUpdate(
            { id_cliente: 'C001' },
            { $set: { activo: false }, $inc: { version: 1 } },
            { session, returnDocument: 'after' },
          );
          await registrarEvento(db, session, eventoCliente(contenido));
          throw fallo;
        }),
        (error) => error === fallo,
      );
      assert.deepEqual(await snapshot(db), antes);
    });

    await t.test('un evento inválido o duplicado aborta los cambios previos', async () => {
      const contenido = await clientes.findOne({ id_cliente: 'C001' });
      for (const [evento, code] of [
        [{ ...eventoCliente(contenido), version: contenido.version + 1 }, 'EVENTO_INVALIDO'],
        [eventoCliente(contenido), 11000],
      ]) {
        const antes = await snapshot(db);
        await assert.rejects(
          enTransaccion(client, async (session) => {
            await clientes.updateOne(
              { id_cliente: 'C001' },
              { $set: { activo: false } },
              { session },
            );
            await registrarEvento(db, session, evento);
          }),
          { code },
        );
        assert.deepEqual(await snapshot(db), antes);
      }
    });

    await t.test(
      'q14: fallar el segundo evento revierte venta, stock, receta y primer evento',
      async () => {
        await db
          .collection('stock_lotes')
          .updateMany({}, { $set: { vencimiento: diasDesdeHoy(200) } });
        const receta = await db.collection('recetas').findOne({ id_receta: 'RC004' });
        const version = receta.version + 1;
        // Conflicto controlado en el segundo insert: q14 ya habrá escrito el evento de venta.
        await enTransaccion(client, (session) =>
          registrarEvento(db, session, {
            tipo_entidad: 'receta',
            id_entidad: receta.id_receta,
            version,
            contenido: { ...receta, version },
          }),
        );
        const pedido = {
          id_venta: 'V-OUTBOX',
          id_cliente: 'C006',
          id_farmaceutico: 'F001',
          id_receta: 'RC004',
          medio_pago: 'Efectivo',
          items: [{ id_producto: 'PRD003', cantidad: 1 }],
        };
        const antes = await snapshot(db);
        await assert.rejects(q14({ client, db }, pedido), { code: 11000 });
        assert.deepEqual(await snapshot(db), antes);
        assert.equal(await outbox.countDocuments({ id_entidad: pedido.id_venta }), 0);

        await outbox.deleteOne({ id_evento: `receta:RC004:${version}` });
        const resultado = await q14({ client, db }, pedido);
        assert.equal(resultado.ya_registrada, false);
        const eventoVenta = await outbox.findOne({ id_evento: 'venta:V-OUTBOX:1' });
        const eventoReceta = await outbox.findOne({ id_evento: `receta:RC004:${version}` });
        assert.deepEqual(eventoVenta.contenido, resultado.venta);
        assert.deepEqual(eventoReceta.contenido, resultado.receta);
        assert.equal(eventoVenta.contenido.stock_aplicado, true);
        assert.equal(resultado.receta.dispensas_realizadas, receta.dispensas_realizadas + 1);
        assert.equal(eventoVenta.estado, 'Pendiente');
        assert.equal(eventoReceta.estado, 'Pendiente');

        const confirmado = await snapshot(db);
        const repetido = await q14({ client, db }, pedido);
        assert.equal(repetido.ya_registrada, true);
        assert.deepEqual(await snapshot(db), confirmado);
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
