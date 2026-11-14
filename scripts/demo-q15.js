import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { connectMongo } from '../src/db/connections.js';
import { ensureSchema } from '../src/db/schema.js';
import { loadData } from '../src/data/load.js';
import { q15 } from '../src/queries/q15.js';
import { errorResult } from '../src/shared/errors.js';

// Demostración de q15 por separado. q15 no abre transacciones: este script abre una y
// le pasa la sesión. Trabaja sobre una base temporal cargada con los CSV y la elimina al
// terminar, así no modifica la base de trabajo.

const settings = {
  ...config(),
  mongoDatabase: `farmared_demo_${randomUUID().replaceAll('-', '')}`,
};
const { client, db } = await connectMongo(settings);

async function enTransaccion(operacion) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => operacion(session));
  } finally {
    await session.endSession();
  }
}

async function intentar(operacion) {
  try {
    return { ok: true, data: await operacion() };
  } catch (error) {
    return errorResult(error);
  }
}

// Venta registrada todavía sin descuento, como la deja q14 antes de llamar a q15
function ventaSinDescuento(idVenta, cantidad) {
  return {
    id_venta: idVenta,
    id_cliente: 'C006',
    id_farmaceutico: 'F002',
    id_sucursal: 'S001',
    id_receta: 'RC003',
    fecha: new Date(),
    tipo: 'Con receta',
    medio_pago: 'Obra social',
    total: cantidad * 9800,
    estado: 'Completada',
    stock_aplicado: false,
    origen: 'operacion',
    items: [{ id_detalle: `${idVenta}-01`, id_producto: 'PRD003', cantidad, precio_unit: 9800 }],
    version: 1,
  };
}

function registrarYDescontar(venta) {
  return enTransaccion(async (session) => {
    await db.collection('ventas').insertOne(venta, { session });
    return q15({ db, session }, { id_venta: venta.id_venta });
  });
}

const lotesPRD003EnS001 = () =>
  db
    .collection('stock_lotes')
    .find(
      { id_sucursal: 'S001', id_producto: 'PRD003' },
      { projection: { _id: 0, id_lote: 1, unidades: 1, vencimiento: 1, version: 1 } },
    )
    .sort({ vencimiento: 1, id_lote: 1 })
    .toArray();

try {
  await ensureSchema(db);
  await loadData(client, db);

  const salida = { fecha_sistema: new Date(), lotes_antes: await lotesPRD003EnS001() };

  salida.sin_transaccion = await intentar(() => q15({ db }, { id_venta: 'V003' }));
  salida.venta_importada = await intentar(() =>
    enTransaccion((session) => q15({ db, session }, { id_venta: 'V003' })),
  );
  salida.descuento_fefo = await intentar(() =>
    registrarYDescontar(ventaSinDescuento('V-DEMO-Q15', 50)),
  );
  salida.lotes_despues = await lotesPRD003EnS001();
  salida.segunda_aplicacion = await intentar(() =>
    enTransaccion((session) => q15({ db, session }, { id_venta: 'V-DEMO-Q15' })),
  );
  salida.stock_insuficiente = await intentar(() =>
    registrarYDescontar(ventaSinDescuento('V-DEMO-FALTA', 10000)),
  );
  salida.venta_rechazada_persistida =
    (await db.collection('ventas').countDocuments({ id_venta: 'V-DEMO-FALTA' })) > 0;
  salida.lotes_final = await lotesPRD003EnS001();

  console.log(JSON.stringify(salida, null, 2));
} finally {
  await db.dropDatabase();
  await client.close();
}
