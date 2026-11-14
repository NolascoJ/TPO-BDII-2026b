import { AppError } from '../../shared/errors.js';
import { inicioDiaUTC, sumarDiasUTC } from './fechas.js';

export const CONDICIONES_CON_RECETA = new Set(['Bajo receta', 'Bajo receta archivada']);
export const DIAS_ENTRE_DISPENSAS = 30;
export const ADVERTENCIA_RECETA_NO_UTILIZADA = 'Receta no utilizada: ningún producto la requiere';

function recetaInvalida(mensaje, detalles) {
  return new AppError('RECETA_INVALIDA', mensaje, detalles);
}

/**
 * Decide el tipo de venta y si se usa la receta del pedido.
 * Con algún producto bajo receta: `Con receta` y receta obligatoria.
 * Sin productos bajo receta: `Venta libre`, sin receta; si vino una, se ignora con advertencia.
 * @param {object[]} productos Productos de la venta, con `condicion_venta`.
 * @param {string|null} idReceta
 * @returns {{tipo: 'Con receta'|'Venta libre', id_receta: string|null, advertencias: string[]}}
 * @throws {AppError} `RECETA_REQUERIDA` si algún producto la necesita y no vino.
 */
export function resolverReceta(productos, idReceta) {
  const requierenReceta = productos
    .filter((producto) => CONDICIONES_CON_RECETA.has(producto.condicion_venta))
    .map((producto) => producto.id_producto);

  if (requierenReceta.length) {
    if (!idReceta) {
      throw new AppError('RECETA_REQUERIDA', 'Hay productos que requieren receta', {
        productos: requierenReceta,
      });
    }
    return { tipo: 'Con receta', id_receta: idReceta, advertencias: [] };
  }
  return {
    tipo: 'Venta libre',
    id_receta: null,
    advertencias: idReceta ? [ADVERTENCIA_RECETA_NO_UTILIZADA] : [],
  };
}

/**
 * Valida que la receta pueda respaldar la venta: existente, del mismo cliente,
 * `Vigente` y con dispensas disponibles.
 * @param {object|null} receta Documento leído en la transacción.
 * @param {{id_receta: string, id_cliente: string}} pedido
 * @throws {AppError} `RECETA_INVALIDA`.
 */
export function validarReceta(receta, { id_receta: idReceta, id_cliente: idCliente }) {
  if (!receta) {
    throw recetaInvalida(`Receta inexistente: ${idReceta}`, { id_receta: idReceta });
  }
  if (receta.id_cliente !== idCliente) {
    throw recetaInvalida('La receta pertenece a otro cliente', {
      id_receta: receta.id_receta,
      id_cliente: idCliente,
    });
  }
  if (receta.estado !== 'Vigente') {
    throw recetaInvalida(`La receta no está vigente: ${receta.estado}`, {
      id_receta: receta.id_receta,
      estado: receta.estado,
    });
  }
  if (receta.dispensas_realizadas >= receta.dispensas_autorizadas) {
    throw recetaInvalida('La receta no tiene dispensas disponibles', {
      id_receta: receta.id_receta,
      dispensas_realizadas: receta.dispensas_realizadas,
      dispensas_autorizadas: receta.dispensas_autorizadas,
    });
  }
}

/**
 * Calcula cómo queda la receta después de una dispensa, sin modificarla.
 * Simple y Archivada se completan con su única dispensa. Tratamiento prolongado
 * fija la próxima dispensa al día UTC de la venta + 30 días mientras queden
 * dispensas, y se completa con próxima dispensa nula al alcanzar las autorizadas.
 * @param {object} receta Receta ya validada con `validarReceta`.
 * @param {Date} fechaVenta
 * @returns {{dispensas_realizadas: number, proxima_dispensa: Date|null,
 *   estado: 'Vigente'|'Completada'}}
 */
export function siguienteEstadoReceta(receta, fechaVenta) {
  const realizadas = receta.dispensas_realizadas + 1;
  const completa =
    receta.tipo !== 'Tratamiento prolongado' || realizadas >= receta.dispensas_autorizadas;
  if (completa) {
    return { dispensas_realizadas: realizadas, proxima_dispensa: null, estado: 'Completada' };
  }
  return {
    dispensas_realizadas: realizadas,
    proxima_dispensa: sumarDiasUTC(inicioDiaUTC(fechaVenta), DIAS_ENTRE_DISPENSAS),
    estado: 'Vigente',
  };
}
