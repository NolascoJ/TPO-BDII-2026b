import { AppError } from '../../shared/errors.js';
import { inicioDiaUTC } from './fechas.js';

/**
 * Lotes que pueden dispensarse, ordenados por FEFO.
 * Vigente: vencimiento >= inicio del día UTC actual, con unidades disponibles.
 * Orden: vencimiento ascendente y, si empatan, id_lote ascendente.
 * @param {{id_lote: string, unidades: number, vencimiento: Date}[]} lotes
 * @param {Date} ahora
 * @returns {object[]} Copia filtrada y ordenada; no modifica el arreglo recibido.
 */
export function lotesVigentesFefo(lotes, ahora) {
  const hoy = inicioDiaUTC(ahora).getTime();
  return lotes
    .filter((lote) => lote.vencimiento.getTime() >= hoy && lote.unidades > 0)
    .sort((a, b) => {
      const porVencimiento = a.vencimiento.getTime() - b.vencimiento.getTime();
      if (porVencimiento !== 0) {
        return porVencimiento;
      }
      if (a.id_lote === b.id_lote) {
        return 0;
      }
      return a.id_lote < b.id_lote ? -1 : 1;
    });
}

/**
 * Plan de descuento FEFO para un producto: qué lote y cuántas unidades.
 * Recibe solamente lotes de la sucursal de la venta y de ese producto.
 * @param {{id_lote: string, unidades: number, vencimiento: Date}[]} lotes
 * @param {{id_producto: string, cantidad: number}} pedido
 * @param {Date} ahora
 * @returns {{id_lote: string, descontar: number}[]}
 * @throws {AppError} `STOCK_INSUFICIENTE` si el stock vigente no alcanza.
 */
export function planificarFefo(lotes, { id_producto: idProducto, cantidad }, ahora) {
  const plan = [];
  let pendiente = cantidad;
  for (const lote of lotesVigentesFefo(lotes, ahora)) {
    if (pendiente === 0) {
      break;
    }
    const descontar = Math.min(lote.unidades, pendiente);
    plan.push({ id_lote: lote.id_lote, descontar });
    pendiente -= descontar;
  }
  if (pendiente > 0) {
    throw new AppError('STOCK_INSUFICIENTE', `Stock vigente insuficiente para ${idProducto}`, {
      id_producto: idProducto,
      requerido: cantidad,
      disponible: cantidad - pendiente,
    });
  }
  return plan;
}

/**
 * Suma las cantidades de los ítems por producto.
 * @param {{id_producto: string, cantidad: number}[]} items
 * @returns {Map<string, number>}
 */
export function agruparCantidades(items) {
  const cantidades = new Map();
  for (const item of items) {
    cantidades.set(item.id_producto, (cantidades.get(item.id_producto) ?? 0) + item.cantidad);
  }
  return cantidades;
}
