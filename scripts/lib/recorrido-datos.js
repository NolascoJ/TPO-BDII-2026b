import assert from 'node:assert/strict';
import { queries } from '../../src/queries/registry.js';
import { q13 } from '../../src/queries/q13.js';
import { q14 } from '../../src/queries/q14.js';
import { q15 } from '../../src/queries/q15.js';
import { q03 } from '../../src/queries/q03.js';
import { procesarOutbox } from '../../src/outbox/procesar.js';
import { snapshotMongo } from './demo.js';

export async function recorrerDatos(ctx) {
  const { db, client, id } = ctx;
  const lecturas = {};
  for (let n = 1; n <= 12; n += 1) {
    const nombre = `q${String(n).padStart(2, '0')}`;
    const parametros = {};
    if (n === 3) {
      parametros.id_cliente = id('AD-C004');
    }
    if (n === 10) {
      parametros.id_sucursal = id('AD-S001');
    }
    lecturas[nombre] = await queries[nombre].run(ctx, parametros);
  }
  const abm = await q13(ctx, {
    accion: 'modificar',
    id_cliente: id('AD-C014'),
    datos: { telefono: '01155559999' },
  });
  const pedido = {
    id_venta: id('AD-V-OPERACION'),
    id_cliente: id('AD-C013'),
    id_farmaceutico: id('AD-F001'),
    id_receta: id('AD-R004'),
    medio_pago: 'Efectivo',
    items: [{ id_producto: id('AD-P009'), cantidad: 5 }],
  };
  const stock = () =>
    db
      .collection('stock_lotes')
      .find(
        { id_producto: id('AD-P009'), id_sucursal: id('AD-S001') },
        { projection: { _id: 0, id_lote: 1, unidades: 1, vencimiento: 1 } },
      )
      .sort({ id_lote: 1 })
      .toArray();
  const antes = await stock();
  const venta = await q14(ctx, pedido);
  const despues = await stock();
  const copia = await snapshotMongo(db);
  const session = client.startSession();
  try {
    await assert.rejects(
      session.withTransaction(() => q15({ ...ctx, session }, { id_venta: pedido.id_venta })),
      { code: 'STOCK_YA_APLICADO' },
    );
  } finally {
    await session.endSession();
  }
  await assert.rejects(
    q14(ctx, {
      ...pedido,
      id_venta: id('AD-V-RECHAZO'),
      items: [{ id_producto: id('AD-P009'), cantidad: 10000 }],
    }),
    { code: 'STOCK_INSUFICIENTE' },
  );
  assert.equal(await snapshotMongo(db), copia);
  const sincronizacion = await procesarOutbox(ctx);
  assert.equal(sincronizacion.fallidos, 0);
  assert.equal(sincronizacion.pendientes, 0);
  const historial = await q03(ctx, { id_cliente: pedido.id_cliente });
  assert.equal(historial.historial.filter((e) => e.id_venta === pedido.id_venta).length, 1);
  return {
    lecturas,
    q13: {
      id_cliente: abm.cliente.id_cliente,
      version: abm.cliente.version,
      telefono: abm.cliente.telefono,
    },
    q14: {
      id_venta: venta.venta.id_venta,
      total: venta.venta.total,
      movimientos: venta.movimientos,
      stock_antes: antes,
      stock_despues: despues,
    },
    q15: { segundo_descuento: 'STOCK_YA_APLICADO', rechazo_sin_cambios: true },
    rechazo_venta: { error: 'STOCK_INSUFICIENTE', sin_cambios: true },
    sincronizacion,
  };
}
