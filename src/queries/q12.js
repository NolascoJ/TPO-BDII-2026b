import { aDateTime } from '../graph/mapeo.js';
import { ultimoAnio } from '../graph/periodos.js';
import { registros } from '../graph/valores.js';

const CYPHER = `
MATCH (c:Cliente)
WHERE NOT EXISTS {
  (c)-[:REALIZO]->(v:Venta) WHERE v.estado <> 'Anulada' AND v.fecha >= $desde AND v.fecha <= $hasta
}
WITH c, COLLECT {
  MATCH (c)-[:REALIZO]->(v:Venta) WHERE v.estado <> 'Anulada'
  RETURN v.fecha ORDER BY v.fecha DESC LIMIT 1
} AS ultima
RETURN c.id_cliente AS id_cliente, c.nombre AS nombre, c.apellido AS apellido,
       c.activo AS activo, ultima[0] AS ultima_compra, size(ultima) = 0 AS nunca_compro
ORDER BY id_cliente`;

/**
 * q12: clientes sin ventas registradas en el último año, incluidos los que nunca compraron
 * (Neo4j).
 *
 * Busca clientes sin ninguna relación `REALIZO` hacia una venta con fecha en
 * `[mismo instante del año anterior, ahora]`, con el reloj del sistema. Decisión del equipo:
 * una venta `Anulada` no cuenta como registrada (no tuvo efecto); las `Pendiente` sí. Lista
 * clientes activos e inactivos, con su `activo`, la última compra válida y si nunca compró.
 *
 * @param {{driver: import('neo4j-driver').Driver, neo4jDatabase: string}} context
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<{desde: Date, hasta: Date, clientes: object[]}>}
 */
export async function q12({ driver, neo4jDatabase }, _params = {}) {
  const { desde, hasta } = ultimoAnio(new Date());
  const clientes = registros(
    await driver.executeQuery(
      CYPHER,
      { desde: aDateTime(desde), hasta: aDateTime(hasta) },
      { database: neo4jDatabase },
    ),
  );
  return { desde, hasta, clientes };
}
