import { aDateTime } from '../graph/mapeo.js';
import { ultimos60Dias } from '../graph/periodos.js';
import { registros } from '../graph/valores.js';

const CYPHER = `
MATCH (f:Farmaceutico {activo: true})
OPTIONAL MATCH (f)-[:TRABAJA_EN]->(s:Sucursal)
RETURN f.id_farmaceutico AS id_farmaceutico, f.nombre AS nombre, f.apellido AS apellido,
       f.matricula AS matricula, s {.id_sucursal, .nombre} AS sucursal,
       COUNT {
         (f)<-[:ATENDIDA_POR]-(v:Venta)
         WHERE v.estado <> 'Anulada' AND v.fecha >= $desde AND v.fecha <= $hasta
       } AS ventas
ORDER BY ventas DESC, id_farmaceutico`;

/**
 * q05: farmacéuticos activos y cantidad de ventas de los últimos 60 días (Neo4j).
 *
 * Parte de todos los farmacéuticos activos y cuenta sus ventas (`ATENDIDA_POR`) con fecha en
 * `[ahora − 60 días, ahora]`, calculado con el reloj del sistema. Excluye solo las `Anulada`:
 * las `Pendiente` cuentan. Los que no tienen ventas aparecen con 0 (el conteo es por
 * farmacéutico, no por venta). `sucursal` es la actual (`TRABAJA_EN`).
 *
 * @param {{driver: import('neo4j-driver').Driver, neo4jDatabase: string}} context
 * @param {object} _params Sin parámetros de negocio.
 * @returns {Promise<{desde: Date, hasta: Date, farmaceuticos: object[]}>}
 */
export async function q05({ driver, neo4jDatabase }, _params = {}) {
  const { desde, hasta } = ultimos60Dias(new Date());
  const farmaceuticos = registros(
    await driver.executeQuery(
      CYPHER,
      { desde: aDateTime(desde), hasta: aDateTime(hasta) },
      { database: neo4jDatabase },
    ),
  );
  return { desde, hasta, farmaceuticos };
}
