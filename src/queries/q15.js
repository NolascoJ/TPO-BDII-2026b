import { AppError } from '../shared/errors.js';
import { inicioDiaUTC } from '../services/venta/fechas.js';
import { agruparCantidades, planificarFefo } from '../services/venta/fefo.js';

function validarParametros(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new AppError('PARAMETROS_INVALIDOS', 'Se esperaba un objeto con id_venta');
  }
  const extra = Object.keys(params).filter((campo) => campo !== 'id_venta');
  if (extra.length) {
    throw new AppError('PARAMETROS_INVALIDOS', `Campo no permitido: ${extra.join(', ')}`, {
      campos: extra,
    });
  }
  if (typeof params.id_venta !== 'string' || params.id_venta.trim() === '') {
    throw new AppError('PARAMETROS_INVALIDOS', 'Falta id_venta o no es un string válido', {
      campo: 'id_venta',
    });
  }
}

function validarVenta(venta, idVenta) {
  if (!venta) {
    throw new AppError('VENTA_INVALIDA', `Venta inexistente: ${idVenta}`, { id_venta: idVenta });
  }
  // Las ventas importadas ya están reflejadas en el stock del CSV
  if (venta.origen !== 'operacion') {
    throw new AppError('VENTA_INVALIDA', 'Las ventas importadas no descuentan stock', {
      id_venta: idVenta,
      origen: venta.origen,
    });
  }
  if (venta.estado !== 'Completada') {
    throw new AppError('VENTA_INVALIDA', `Una venta ${venta.estado} no descuenta stock`, {
      id_venta: idVenta,
      estado: venta.estado,
    });
  }
  if (venta.stock_aplicado) {
    throw new AppError('STOCK_YA_APLICADO', 'El stock de esta venta ya fue descontado', {
      id_venta: idVenta,
    });
  }
}

/**
 * q15: descuenta del stock todos los ítems de una venta registrada, por FEFO (MongoDB).
 *
 * Solo usa lotes vigentes de la sucursal de la venta. Si algún producto no tiene
 * stock suficiente lanza un error y no confirma nada: quien abrió la transacción
 * la aborta y ningún lote queda modificado. Marca la venta con `stock_aplicado`
 * para que una segunda llamada no vuelva a descontar.
 *
 * Debe ejecutarse dentro de una transacción abierta por quien llama (q14 o un
 * script de demostración); q15 no confirma ni aborta por su cuenta.
 *
 * @param {{db: import('mongodb').Db, session: import('mongodb').ClientSession}} context
 * @param {{id_venta: string}} params
 * @returns {Promise<{id_venta: string, id_sucursal: string,
 *   movimientos: {id_lote: string, id_producto: string, descontar: number}[]}>}
 * @throws {AppError} `TRANSACCION_REQUERIDA`, `PARAMETROS_INVALIDOS`, `VENTA_INVALIDA`,
 *   `STOCK_YA_APLICADO` o `STOCK_INSUFICIENTE`.
 */
export async function q15({ db, session } = {}, params = {}) {
  if (!session?.inTransaction()) {
    throw new AppError('TRANSACCION_REQUERIDA', 'q15 debe ejecutarse dentro de una transacción');
  }
  validarParametros(params);
  const idVenta = params.id_venta;

  const ventas = db.collection('ventas');
  const lotes = db.collection('stock_lotes');
  const venta = await ventas.findOne({ id_venta: idVenta }, { session });
  validarVenta(venta, idVenta);

  const ahora = new Date();
  const hoy = inicioDiaUTC(ahora);

  // Primero se planifica todo: si un producto no alcanza, no se escribe ningún lote
  const movimientos = [];
  for (const [idProducto, cantidad] of agruparCantidades(venta.items)) {
    const disponibles = await lotes
      .find(
        {
          id_sucursal: venta.id_sucursal,
          id_producto: idProducto,
          vencimiento: { $gte: hoy },
          unidades: { $gt: 0 },
        },
        { session },
      )
      .sort({ vencimiento: 1, id_lote: 1 })
      .toArray();
    for (const paso of planificarFefo(disponibles, { id_producto: idProducto, cantidad }, ahora)) {
      movimientos.push({ ...paso, id_producto: idProducto });
    }
  }

  // La condición sobre unidades y vencimiento evita saldos negativos aunque el lote
  // haya cambiado; una escritura concurrente sobre el mismo lote produce un conflicto
  // transitorio y el driver reintenta la transacción completa
  for (const movimiento of movimientos) {
    const resultado = await lotes.updateOne(
      {
        id_lote: movimiento.id_lote,
        unidades: { $gte: movimiento.descontar },
        vencimiento: { $gte: hoy },
      },
      { $inc: { unidades: -movimiento.descontar, version: 1 } },
      { session },
    );
    if (resultado.modifiedCount !== 1) {
      throw new AppError('STOCK_INSUFICIENTE', `El lote ${movimiento.id_lote} cambió`, {
        id_lote: movimiento.id_lote,
        id_producto: movimiento.id_producto,
        requerido: movimiento.descontar,
      });
    }
  }

  const marca = await ventas.updateOne(
    { id_venta: idVenta, stock_aplicado: false },
    { $set: { stock_aplicado: true } },
    { session },
  );
  if (marca.modifiedCount !== 1) {
    throw new AppError('STOCK_YA_APLICADO', 'El stock de esta venta ya fue descontado', {
      id_venta: idVenta,
    });
  }

  return { id_venta: idVenta, id_sucursal: venta.id_sucursal, movimientos };
}
