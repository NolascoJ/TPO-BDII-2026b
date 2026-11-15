/**
 * q11: ingresos por farmacéutico en el mes actual, solo ventas completadas (MongoDB).
 * Calcula `[inicio del mes UTC, inicio del siguiente mes UTC)` al invocarse.
 * Suma el total histórico una vez por venta, sin desarmar los ítems ni usar precios actuales.
 * Incluye profesionales inactivos; aparecen solo quienes tienen ventas completadas en el mes.
 * @param {{db: import('mongodb').Db}} context Conexión compartida.
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<object[]>} `{id_farmaceutico, ingresos_totales, farmaceutico}`, ordenados
 *   por ingresos descendentes e ID ascendente para desempatar.
 */
export async function q11({ db }, _params = {}) {
  const ahora = new Date();
  const desde = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
  const hasta = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 1));

  return db
    .collection('ventas')
    .aggregate([
      { $match: { estado: 'Completada', fecha: { $gte: desde, $lt: hasta } } },
      {
        $group: {
          _id: '$id_farmaceutico',
          ingresos_totales: { $sum: '$total' },
        },
      },
      { $sort: { ingresos_totales: -1, _id: 1 } },
      {
        $lookup: {
          from: 'farmaceuticos',
          localField: '_id',
          foreignField: 'id_farmaceutico',
          as: 'farmaceutico',
        },
      },
      { $unwind: { path: '$farmaceutico', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, id_farmaceutico: '$_id', ingresos_totales: 1, farmaceutico: 1 } },
    ])
    .toArray();
}
