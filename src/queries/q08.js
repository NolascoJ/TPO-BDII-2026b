/**
 * q08: lotes con menos de 50 unidades y relaciones completas (MongoDB).
 * @param {{db: import('mongodb').Db}} context Conexión compartida.
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<object[]>} Lotes con producto, sucursal y proveedor, incluidos vencidos.
 */
export async function q08({ db }, _params = {}) {
  return db
    .collection('stock_lotes')
    .aggregate([
      {
        $match: {
          unidades: {
            $lt: 50,
          },
        },
      },
      {
        $lookup: {
          from: 'productos',
          localField: 'id_producto',
          foreignField: 'id_producto',
          as: 'producto',
        },
      },
      {
        $unwind: {
          path: '$producto',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: 'sucursales',
          localField: 'id_sucursal',
          foreignField: 'id_sucursal',
          as: 'sucursal',
        },
      },
      {
        $unwind: {
          path: '$sucursal',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: 'proveedores',
          localField: 'producto.id_proveedor',
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
          unidades: 1,
          id_lote: 1,
        },
      },
    ])
    .toArray();
}
