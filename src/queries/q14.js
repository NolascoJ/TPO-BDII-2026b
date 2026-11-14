import { AppError } from '../shared/errors.js';
import {
  validarPedido,
  construirItems,
  calcularTotal,
  diferenciasConVenta,
  validarMedioPago,
} from '../services/venta/pedido.js';
import {
  resolverReceta,
  validarReceta,
  siguienteEstadoReceta,
  ADVERTENCIA_RECETA_NO_UTILIZADA,
} from '../services/venta/receta.js';
import { registrarEvento } from '../services/venta/eventos.js';
import { q15 } from './q15.js';

const sinId = { projection: { _id: 0 } };

const esIdVentaDuplicado = (error) => error?.code === 11000 && error.keyPattern?.id_venta === 1;

// Un pedido repetido con el mismo contenido devuelve la venta ya registrada sin nuevos efectos
function reconocerReintento(venta, pedido) {
  if (venta.origen !== 'operacion') {
    throw new AppError('CONFLICTO_IDEMPOTENCIA', 'El id_venta pertenece a una venta importada', {
      id_venta: venta.id_venta,
      origen: venta.origen,
    });
  }
  const diferencias = diferenciasConVenta(venta, pedido);
  if (diferencias.length) {
    throw new AppError(
      'CONFLICTO_IDEMPOTENCIA',
      `Ya existe la venta ${venta.id_venta} con otro contenido`,
      { id_venta: venta.id_venta, campos: diferencias },
    );
  }
  const recetaIgnorada = pedido.id_receta !== null && venta.tipo === 'Venta libre';
  return {
    venta,
    receta: null,
    movimientos: [],
    advertencias: recetaIgnorada ? [ADVERTENCIA_RECETA_NO_UTILIZADA] : [],
    ya_registrada: true,
  };
}

async function validarCliente(db, session, idCliente) {
  const cliente = await db.collection('clientes').findOne({ id_cliente: idCliente }, { session });
  if (!cliente) {
    throw new AppError('CLIENTE_INVALIDO', `Cliente inexistente: ${idCliente}`, {
      id_cliente: idCliente,
    });
  }
  if (cliente.activo !== true) {
    throw new AppError('CLIENTE_INVALIDO', `Cliente inactivo: ${idCliente}`, {
      id_cliente: idCliente,
    });
  }
  return cliente;
}

async function validarFarmaceutico(db, session, idFarmaceutico) {
  const farmaceutico = await db
    .collection('farmaceuticos')
    .findOne({ id_farmaceutico: idFarmaceutico }, { session });
  if (!farmaceutico) {
    throw new AppError('FARMACEUTICO_INVALIDO', `Farmacéutico inexistente: ${idFarmaceutico}`, {
      id_farmaceutico: idFarmaceutico,
    });
  }
  if (farmaceutico.activo !== true) {
    throw new AppError('FARMACEUTICO_INVALIDO', `Farmacéutico inactivo: ${idFarmaceutico}`, {
      id_farmaceutico: idFarmaceutico,
    });
  }
  const sucursal = await db
    .collection('sucursales')
    .findOne({ id_sucursal: farmaceutico.id_sucursal }, { session });
  if (!sucursal || sucursal.tipo !== 'Farmacia') {
    throw new AppError(
      'FARMACEUTICO_INVALIDO',
      'El farmacéutico no pertenece a una sucursal de tipo Farmacia',
      { id_farmaceutico: idFarmaceutico, id_sucursal: farmaceutico.id_sucursal },
    );
  }
  if (sucursal.activo !== true) {
    throw new AppError('SUCURSAL_INVALIDA', `Sucursal inactiva: ${sucursal.id_sucursal}`, {
      id_sucursal: sucursal.id_sucursal,
    });
  }
  return farmaceutico;
}

async function registrarVenta(db, session, pedido) {
  const ahora = new Date();

  const existente = await db
    .collection('ventas')
    .findOne({ id_venta: pedido.id_venta }, { session, ...sinId });
  if (existente) {
    return reconocerReintento(existente, pedido);
  }

  const cliente = await validarCliente(db, session, pedido.id_cliente);
  validarMedioPago(cliente, pedido.medio_pago);
  const farmaceutico = await validarFarmaceutico(db, session, pedido.id_farmaceutico);

  const productos = await db
    .collection('productos')
    .find({ id_producto: { $in: pedido.items.map((item) => item.id_producto) } }, { session })
    .toArray();
  const items = construirItems(pedido.id_venta, pedido.items, productos);
  const { tipo, id_receta: idReceta, advertencias } = resolverReceta(productos, pedido.id_receta);

  let receta = null;
  if (idReceta) {
    receta = await db.collection('recetas').findOne({ id_receta: idReceta }, { session });
    validarReceta(receta, { id_receta: idReceta, id_cliente: pedido.id_cliente });
  }

  // id_venta es único: si dos pedidos llegan a la vez, solo uno puede insertarse
  await db.collection('ventas').insertOne(
    {
      id_venta: pedido.id_venta,
      id_cliente: pedido.id_cliente,
      id_farmaceutico: pedido.id_farmaceutico,
      id_sucursal: farmaceutico.id_sucursal,
      id_receta: idReceta,
      fecha: ahora,
      tipo,
      medio_pago: pedido.medio_pago,
      total: calcularTotal(items),
      estado: 'Completada',
      stock_aplicado: false,
      origen: 'operacion',
      items,
      version: 1,
    },
    { session },
  );

  const { movimientos } = await q15({ db, session }, { id_venta: pedido.id_venta });

  let recetaActualizada = null;
  if (receta) {
    // La condición evita aplicar la dispensa sobre una receta que cambió desde la lectura
    recetaActualizada = await db.collection('recetas').findOneAndUpdate(
      {
        id_receta: receta.id_receta,
        estado: 'Vigente',
        dispensas_realizadas: receta.dispensas_realizadas,
      },
      { $set: siguienteEstadoReceta(receta, ahora), $inc: { version: 1 } },
      { session, returnDocument: 'after', ...sinId },
    );
    if (!recetaActualizada) {
      throw new AppError('RECETA_INVALIDA', 'La receta cambió durante la operación', {
        id_receta: receta.id_receta,
      });
    }
  }

  const venta = await db
    .collection('ventas')
    .findOne({ id_venta: pedido.id_venta }, { session, ...sinId });
  await registrarEvento(db, session, {
    tipo_entidad: 'venta',
    id_entidad: venta.id_venta,
    version: venta.version,
    contenido: venta,
  });
  if (recetaActualizada) {
    await registrarEvento(db, session, {
      tipo_entidad: 'receta',
      id_entidad: recetaActualizada.id_receta,
      version: recetaActualizada.version,
      contenido: recetaActualizada,
    });
  }

  return { venta, receta: recetaActualizada, movimientos, advertencias, ya_registrada: false };
}

/**
 * q14: registra una venta `Completada` con sus ítems (MongoDB).
 *
 * En una única transacción valida cliente, farmacéutico, sucursal, productos y receta;
 * calcula el total con los precios vigentes del catálogo; descuenta el stock con q15;
 * actualiza la receta y registra los eventos de sincronización. Si cualquier paso
 * falla no queda persistido nada: ni la venta, ni descuentos, ni cambios de receta,
 * ni eventos.
 *
 * `id_venta` identifica el pedido: si se repite con el mismo contenido (por ejemplo,
 * porque se perdió la respuesta), devuelve la venta existente con `ya_registrada: true`
 * y no vuelve a descontar stock ni dispensas.
 *
 * @param {{client: import('mongodb').MongoClient, db: import('mongodb').Db}} context
 * @param {{id_venta: string, id_cliente: string, id_farmaceutico: string,
 *   id_receta?: string|null, medio_pago: string,
 *   items: {id_producto: string, cantidad: number}[]}} params
 * @returns {Promise<{venta: object, receta: object|null,
 *   movimientos: {id_lote: string, id_producto: string, descontar: number}[],
 *   advertencias: string[], ya_registrada: boolean}>}
 * @throws {AppError} `PARAMETROS_INVALIDOS`, `ITEMS_INVALIDOS`, `CLIENTE_INVALIDO`,
 *   `MEDIO_PAGO_INVALIDO`, `FARMACEUTICO_INVALIDO`, `SUCURSAL_INVALIDA`, `PRODUCTO_INVALIDO`,
 *   `RECETA_REQUERIDA`, `RECETA_INVALIDA`, `STOCK_INSUFICIENTE` o `CONFLICTO_IDEMPOTENCIA`.
 */
export async function q14({ client, db }, params = {}) {
  const pedido = validarPedido(params);
  const session = client.startSession();
  try {
    for (let intento = 1; ; intento += 1) {
      try {
        return await session.withTransaction(() => registrarVenta(db, session, pedido), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });
      } catch (error) {
        // Otro pedido con el mismo id_venta se confirmó primero: se reintenta para reconocerlo
        if (intento === 1 && esIdVentaDuplicado(error)) {
          continue;
        }
        throw error;
      }
    }
  } finally {
    await session.endSession();
  }
}
