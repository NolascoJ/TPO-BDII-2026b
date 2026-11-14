/**
 * q02: ventas pendientes con profesional, matrícula, sucursal y total (MongoDB).
 * @param {{db: import('mongodb').Db}} context Conexión compartida.
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<object[]>} Ventas con farmacéutico y sucursal completos, aun inactivos.
 */
export async function q02({ db }, _params = {}) {
  return db
    .collection('ventas')
    .aggregate([
      {
        $match: {
          estado: 'Pendiente',
        },
      },
      {
        $lookup: {
          from: 'farmaceuticos',
          localField: 'id_farmaceutico',
          foreignField: 'id_farmaceutico',
          as: 'farmaceutico',
        },
      },
      {
        $unwind: {
          path: '$farmaceutico',
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
        $sort: {
          fecha: 1,
          id_venta: 1,
        },
      },
    ])
    .toArray();
}
