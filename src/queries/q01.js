/**
 * q01: productos activos con todos los datos de su proveedor (MongoDB).
 * @param {{db: import('mongodb').Db}} context Conexión compartida.
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<object[]>} Productos con el objeto proveedor completo.
 */
export async function q01({ db }, _params = {}) {
  return db
    .collection('productos')
    .aggregate([
      {
        $match: {
          activo: true,
        },
      },
      {
        $lookup: {
          from: 'proveedores',
          localField: 'id_proveedor',
          foreignField: 'id_proveedor',
          as: 'proveedor',
        },
      },
      {
        $unwind: {
          path: '$proveedor',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $sort: {
          id_producto: 1,
        },
      },
    ])
    .toArray();
}
