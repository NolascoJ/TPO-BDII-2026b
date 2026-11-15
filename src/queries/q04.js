import { registros } from '../graph/valores.js';

const CYPHER = `
MATCH (c:Cliente)-[:TIENE_RECETA]->(r:Receta)
WITH c, r ORDER BY r.id_receta
WITH c, count(r) AS cantidad_recetas, collect(r.id_receta) AS recetas
WHERE cantidad_recetas > 1
RETURN c.id_cliente AS id_cliente, c.nombre AS nombre, c.apellido AS apellido,
       c.activo AS activo, cantidad_recetas, recetas
ORDER BY cantidad_recetas DESC, id_cliente`;

/**
 * q04: clientes con más de una receta registrada y su cantidad (Neo4j).
 *
 * Cuenta las relaciones `(Cliente)-[:TIENE_RECETA]->(Receta)` de cada cliente, en cualquier
 * estado de receta y sin filtrar por actividad del cliente (el enunciado no lo pide).
 *
 * @param {{driver: import('neo4j-driver').Driver, neo4jDatabase: string}} context
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<object[]>} `{id_cliente, nombre, apellido, activo, cantidad_recetas, recetas}`.
 */
export async function q04({ driver, neo4jDatabase }, _params = {}) {
  return registros(await driver.executeQuery(CYPHER, {}, { database: neo4jDatabase }));
}
