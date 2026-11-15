/**
 * q09: ventas libres con total menor a ARS 5.000, excluyendo anuladas (MongoDB).
 * Incluye pendientes y completadas, sin filtros temporales ni de actividad.
 * @param {{db: import('mongodb').Db}} context Conexión compartida.
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<object[]>} Ventas completas con sus ítems, ordenadas por fecha e id_venta.
 */
export async function q09({ db }, _params = {}) {
  return db
    .collection('ventas')
    .find({ tipo: 'Venta libre', total: { $lt: 5000 }, estado: { $ne: 'Anulada' } })
    .sort({ fecha: 1, id_venta: 1 })
    .toArray();
}
