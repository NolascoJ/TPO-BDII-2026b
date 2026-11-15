/**
 * q07: top 5 productos por unidades vendidas en ventas completadas (MongoDB).
 * Considera toda la historia, incluidos productos actualmente inactivos.
 * @param {{db: import('mongodb').Db}} context Conexión compartida.
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<object[]>} `{id_producto, unidades_vendidas, producto}`, ordenados por
 *   unidades descendentes e ID ascendente para desempatar. Devuelve hasta cinco productos.
 */
export async function q07({ db }, _params = {}) {
  return db
    .collection('ventas')
    .aggregate([
      { $match: { estado: 'Completada' } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.id_producto',
          unidades_vendidas: { $sum: '$items.cantidad' },
        },
      },
      { $sort: { unidades_vendidas: -1, _id: 1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'productos',
          localField: '_id',
          foreignField: 'id_producto',
          as: 'producto',
        },
      },
      { $unwind: { path: '$producto', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 0, id_producto: '$_id', unidades_vendidas: 1, producto: 1 } },
    ])
    .toArray();
}
