// Períodos relativos calculados con el reloj del sistema al invocar cada consulta (decisión del
// equipo, ver contratos.md). Funciones puras: reciben `ahora` para poder probarlas.

const DIA_MS = 24 * 60 * 60 * 1000;

/** Últimos 60 días: `[ahora − 60 días, ahora]`. */
export function ultimos60Dias(ahora) {
  return { desde: new Date(ahora.getTime() - 60 * DIA_MS), hasta: new Date(ahora.getTime()) };
}

/**
 * Último año: desde el mismo instante del año anterior hasta ahora. El 29/2 se ajusta al
 * 28/2 del año anterior (último día de febrero).
 */
export function ultimoAnio(ahora) {
  const anio = ahora.getUTCFullYear() - 1;
  const mes = ahora.getUTCMonth();
  const ultimoDiaDelMes = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  const desde = new Date(
    Date.UTC(
      anio,
      mes,
      Math.min(ahora.getUTCDate(), ultimoDiaDelMes),
      ahora.getUTCHours(),
      ahora.getUTCMinutes(),
      ahora.getUTCSeconds(),
      ahora.getUTCMilliseconds(),
    ),
  );
  return { desde, hasta: new Date(ahora.getTime()) };
}
