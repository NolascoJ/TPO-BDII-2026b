import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { connectMongo } from '../src/db/connections.js';
import { ensureSchema } from '../src/db/schema.js';
import { loadData } from '../src/data/load.js';
import { q14 } from '../src/queries/q14.js';
import { errorResult } from '../src/shared/errors.js';

// Evidencia de q14 con estados antes y después. Trabaja sobre una base temporal cargada
// con los CSV y la elimina al terminar, así no modifica la base de trabajo.

const settings = {
  ...config(),
  mongoDatabase: `farmared_demo_${randomUUID().replaceAll('-', '')}`,
};
const { client, db } = await connectMongo(settings);
const contexto = { client, db };
const sinId = { projection: { _id: 0 } };

async function intentar(operacion) {
  try {
    return { ok: true, data: await operacion() };
  } catch (error) {
    return errorResult(error);
  }
}

async function contenidoCompleto() {
  const colecciones = await db.listCollections({}, { nameOnly: true }).toArray();
  const partes = [];
  for (const { name } of colecciones.sort((a, b) => a.name.localeCompare(b.name))) {
    partes.push([name, await db.collection(name).find().sort({ _id: 1 }).toArray()]);
  }
  return JSON.stringify(partes);
}

async function estado({ idVenta, idReceta, idProducto, idSucursal }) {
  return {
    venta: await db.collection('ventas').findOne({ id_venta: idVenta }, sinId),
    receta: idReceta
      ? await db.collection('recetas').findOne({ id_receta: idReceta }, sinId)
      : null,
    lotes: await db
      .collection('stock_lotes')
      .find({ id_producto: idProducto, id_sucursal: idSucursal }, sinId)
      .sort({ vencimiento: 1, id_lote: 1 })
      .toArray(),
    eventos: await db
      .collection('outbox')
      .find({ id_entidad: { $in: [idVenta, idReceta] } }, { projection: { _id: 0, contenido: 0 } })
      .toArray(),
  };
}

// Ejecuta q14 y registra el estado antes y después; para rechazos verifica que la base no cambió
async function caso(pedido, foco) {
  const antes = await estado(foco);
  const contenidoAntes = await contenidoCompleto();
  const resultado = await intentar(() => q14(contexto, pedido));
  return {
    pedido,
    antes,
    resultado,
    despues: await estado(foco),
    base_sin_cambios: (await contenidoCompleto()) === contenidoAntes,
  };
}

try {
  await ensureSchema(db);
  await loadData(client, db);

  const ventaConReceta = {
    id_venta: 'V-DEMO-01',
    id_cliente: 'C006',
    id_farmaceutico: 'F002',
    id_receta: 'RC003',
    medio_pago: 'Obra social',
    items: [{ id_producto: 'PRD003', cantidad: 50 }],
  };
  const focoPRD003 = { idProducto: 'PRD003', idSucursal: 'S001' };

  const salida = { fecha_sistema: new Date() };
  salida.venta_exitosa_con_receta = await caso(ventaConReceta, {
    ...focoPRD003,
    idVenta: 'V-DEMO-01',
    idReceta: 'RC003',
  });
  salida.reintento_mismo_pedido = await caso(ventaConReceta, {
    ...focoPRD003,
    idVenta: 'V-DEMO-01',
    idReceta: 'RC003',
  });
  salida.conflicto_mismo_id_otro_contenido = await caso(
    { ...ventaConReceta, items: [{ id_producto: 'PRD003', cantidad: 1 }] },
    { ...focoPRD003, idVenta: 'V-DEMO-01', idReceta: 'RC003' },
  );
  salida.rechazo_receta_vencida = await caso(
    {
      id_venta: 'V-DEMO-02',
      id_cliente: 'C002',
      id_farmaceutico: 'F001',
      id_receta: 'RC009',
      medio_pago: 'Débito',
      items: [{ id_producto: 'PRD003', cantidad: 1 }],
    },
    { ...focoPRD003, idVenta: 'V-DEMO-02', idReceta: 'RC009' },
  );
  salida.rechazo_stock_insuficiente = await caso(
    {
      id_venta: 'V-DEMO-03',
      id_cliente: 'C006',
      id_farmaceutico: 'F001',
      id_receta: 'RC004',
      medio_pago: 'Obra social',
      items: [
        { id_producto: 'PRD001', cantidad: 1 },
        { id_producto: 'PRD006', cantidad: 61 },
      ],
    },
    { idProducto: 'PRD006', idSucursal: 'S001', idVenta: 'V-DEMO-03', idReceta: 'RC004' },
  );
  salida.receta_innecesaria_ignorada = await caso(
    {
      id_venta: 'V-DEMO-04',
      id_cliente: 'C006',
      id_farmaceutico: 'F001',
      id_receta: 'RC004',
      medio_pago: 'Efectivo',
      items: [{ id_producto: 'PRD001', cantidad: 1 }],
    },
    { idProducto: 'PRD001', idSucursal: 'S001', idVenta: 'V-DEMO-04', idReceta: 'RC004' },
  );

  const concurrentes = await Promise.allSettled(
    ['V-DEMO-C1', 'V-DEMO-C2', 'V-DEMO-C3'].map((idVenta) =>
      q14(contexto, {
        id_venta: idVenta,
        id_cliente: 'C003',
        id_farmaceutico: 'F001',
        id_receta: 'RC002',
        medio_pago: 'Obra social',
        items: [{ id_producto: 'PRD003', cantidad: 1 }],
      }),
    ),
  );
  salida.concurrencia_misma_receta = {
    descripcion: 'Tres ventas simultáneas con RC002, a la que le queda una dispensa',
    resultados: concurrentes.map((r) =>
      r.status === 'fulfilled'
        ? { ok: true, id_venta: r.value.venta.id_venta }
        : errorResult(r.reason),
    ),
    receta_final: await db.collection('recetas').findOne({ id_receta: 'RC002' }, sinId),
  };

  console.log(JSON.stringify(salida, null, 2));
} finally {
  await db.dropDatabase();
  await client.close();
}
