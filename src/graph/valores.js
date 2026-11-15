import neo4j from 'neo4j-driver';

// Convierte lo que devuelve el driver de Neo4j a valores comunes de JavaScript, para que las
// consultas del grafo respondan con la misma forma que las de MongoDB: enteros como number y
// fechas como Date.

/** @param {unknown} valor */
export function aJs(valor) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (neo4j.isInt(valor)) {
    return valor.toNumber();
  }
  if (neo4j.isDateTime(valor) || neo4j.isDate(valor)) {
    return valor.toStandardDate();
  }
  if (Array.isArray(valor)) {
    return valor.map(aJs);
  }
  if (typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, aJs(v)]));
  }
  return valor;
}

/** Convierte cada registro de un resultado de Neo4j en un objeto plano. */
export function registros(result) {
  return result.records.map((record) => aJs(record.toObject()));
}
