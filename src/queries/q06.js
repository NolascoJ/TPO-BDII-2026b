import { inicioDiaUTC } from '../services/venta/fechas.js';

/**
 * q06: tratamientos prolongados vigentes con próxima dispensa anterior a hoy (MongoDB).
 * Calcula el inicio del día UTC al invocarse; excluye fechas nulas y las de hoy.
 * Incluye clientes inactivos.
 * @param {{db: import('mongodb').Db}} context Conexión compartida.
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<object[]>} Recetas con el objeto cliente completo, ordenadas por
 *   próxima dispensa e id_receta.
 */
export async function q06({ db }, _params = {}) {
  const hoy = inicioDiaUTC(new Date());
  return db
    .collection('recetas')
    .aggregate([
      {
        $match: {
          tipo: 'Tratamiento prolongado',
          estado: 'Vigente',
          proxima_dispensa: { $type: 'date', $lt: hoy },
        },
      },
      {
        $lookup: {
          from: 'clientes',
          localField: 'id_cliente',
          foreignField: 'id_cliente',
          as: 'cliente',
        },
      },
      { $unwind: { path: '$cliente', preserveNullAndEmptyArrays: true } },
      { $sort: { proxima_dispensa: 1, id_receta: 1 } },
    ])
    .toArray();
}
