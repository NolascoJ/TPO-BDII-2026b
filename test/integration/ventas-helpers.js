// Utilidades compartidas por las pruebas de integración de q14 y q15
import assert from 'node:assert/strict';
import { inicioDiaUTC, sumarDiasUTC } from '../../src/services/venta/fechas.js';

// Las fechas de los lotes se reescriben relativas a hoy para no depender del calendario
export const diasDesdeHoy = (dias) => sumarDiasUTC(inicioDiaUTC(new Date()), dias);

export async function enTransaccion(client, operacion) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => operacion(session));
  } finally {
    await session.endSession();
  }
}

export async function snapshot(db) {
  const resultado = {};
  const colecciones = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of colecciones.sort((a, b) => a.name.localeCompare(b.name))) {
    resultado[name] = await db.collection(name).find().sort({ _id: 1 }).toArray();
  }
  return resultado;
}

// Inserta una venta nueva sin descontar stock, como lo hará q14 antes de llamar a q15
export async function insertarVenta(db, session, idVenta, items, cambios = {}) {
  await db.collection('ventas').insertOne(
    {
      id_venta: idVenta,
      id_cliente: 'C005',
      id_farmaceutico: 'F001',
      id_sucursal: 'S001',
      id_receta: null,
      fecha: new Date(),
      tipo: 'Venta libre',
      medio_pago: 'Efectivo',
      total: 0,
      estado: 'Completada',
      stock_aplicado: false,
      origen: 'operacion',
      items: items.map(([idProducto, cantidad], indice) => ({
        id_detalle: `${idVenta}-${String(indice + 1).padStart(2, '0')}`,
        id_producto: idProducto,
        cantidad,
        precio_unit: 0,
      })),
      version: 1,
      ...cambios,
    },
    { session },
  );
}

export const lote = (db, idLote) => db.collection('stock_lotes').findOne({ id_lote: idLote });

export async function estadoInicial(db) {
  return {
    lotes: new Map(
      (await db.collection('stock_lotes').find().toArray()).map((l) => [l.id_lote, l.unidades]),
    ),
    importadas: await db
      .collection('ventas')
      .find({ origen: 'importacion' })
      .sort({ id_venta: 1 })
      .toArray(),
  };
}

// Reglas que deben cumplirse después de cualquier secuencia de ventas con q14 y q15
export async function assertInvariantes(db, inicial) {
  const lotes = await db.collection('stock_lotes').find().toArray();
  assert.ok(
    lotes.every((l) => l.unidades >= 0),
    'Ningún lote queda con unidades negativas',
  );

  const ventas = await db.collection('ventas').find({ origen: 'operacion' }).toArray();
  const vendido = {};
  for (const venta of ventas) {
    assert.equal(venta.estado, 'Completada');
    assert.equal(venta.stock_aplicado, true, `${venta.id_venta} tiene el stock aplicado`);
    const total = venta.items.reduce((suma, item) => suma + item.cantidad * item.precio_unit, 0);
    assert.equal(venta.total, total, `${venta.id_venta}: total = Σ cantidad × precio`);
    for (const item of venta.items) {
      const clave = `${venta.id_sucursal}|${item.id_producto}`;
      vendido[clave] = (vendido[clave] ?? 0) + item.cantidad;
    }
  }
  const descontado = {};
  for (const l of lotes) {
    const diferencia = inicial.lotes.get(l.id_lote) - l.unidades;
    if (diferencia !== 0) {
      const clave = `${l.id_sucursal}|${l.id_producto}`;
      descontado[clave] = (descontado[clave] ?? 0) + diferencia;
    }
  }
  assert.deepEqual(descontado, vendido, 'El stock descontado coincide con lo vendido');

  for (const receta of await db.collection('recetas').find().toArray()) {
    assert.ok(receta.dispensas_realizadas >= 0);
    assert.ok(receta.dispensas_realizadas <= receta.dispensas_autorizadas);
    if (receta.estado === 'Completada') {
      assert.equal(receta.proxima_dispensa, null, `${receta.id_receta} completada sin próxima`);
    }
    if (receta.tipo === 'Tratamiento prolongado' && receta.estado !== 'Vencida') {
      assert.equal(
        receta.estado === 'Completada',
        receta.dispensas_realizadas === receta.dispensas_autorizadas,
        `${receta.id_receta}: completada solo al alcanzar las dispensas autorizadas`,
      );
    }
    if (receta.version > 1) {
      const evento = await db
        .collection('outbox')
        .findOne({ id_evento: `receta:${receta.id_receta}:${receta.version}` });
      assert.ok(evento, `Evento de la versión actual de ${receta.id_receta}`);
    }
  }

  for (const venta of ventas) {
    const evento = await db
      .collection('outbox')
      .findOne({ id_evento: `venta:${venta.id_venta}:${venta.version}` });
    assert.ok(evento, `Evento de ${venta.id_venta}`);
  }
  assert.deepEqual(
    await db.collection('ventas').find({ origen: 'importacion' }).sort({ id_venta: 1 }).toArray(),
    inicial.importadas,
    'Las ventas importadas no cambian',
  );
}
