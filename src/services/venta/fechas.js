function validarFecha(fecha) {
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) {
    throw new TypeError('Se esperaba una fecha válida');
  }
}

/**
 * @param {Date} fecha
 * @returns {Date}
 */
export function inicioDiaUTC(fecha) {
  validarFecha(fecha);
  return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
}

/**
 * Suma días calendario en UTC sin modificar la fecha recibida.
 * @param {Date} fecha
 * @param {number} dias
 * @returns {Date}
 */
export function sumarDiasUTC(fecha, dias) {
  validarFecha(fecha);
  const resultado = new Date(fecha.getTime());
  resultado.setUTCDate(resultado.getUTCDate() + dias);
  return resultado;
}
