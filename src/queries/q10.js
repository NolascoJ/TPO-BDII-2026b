import { AppError } from '../shared/errors.js';
import { registros } from '../graph/valores.js';

const CYPHER = `
MATCH (s:Sucursal {id_sucursal: $id_sucursal})
RETURN s {.id_sucursal, .nombre, .tipo, .activo} AS sucursal,
  COLLECT {
    MATCH (c:Cliente)-[:REALIZO]->(v:Venta)-[:REGISTRADA_EN]->(s)
    MATCH (v)-[:ATENDIDA_POR]->(f:Farmaceutico)
    WITH c, count(DISTINCT v) AS ventas, max(v.fecha) AS ultima_venta,
         collect(DISTINCT f {.id_farmaceutico, .nombre, .apellido, .activo}) AS farmaceuticos
    RETURN {
      id_cliente: c.id_cliente, nombre: c.nombre, apellido: c.apellido, activo: c.activo,
      ventas: ventas, ultima_venta: ultima_venta, farmaceuticos: farmaceuticos
    }
    ORDER BY c.apellido, c.nombre, c.id_cliente
  } AS clientes`;

/**
 * q10: clientes atendidos en una sucursal (Neo4j), a través del farmacéutico que registró
 * cada venta, esté activo o no.
 *
 * Usa `(Cliente)-[:REALIZO]->(Venta)-[:REGISTRADA_EN]->(Sucursal)`: `REGISTRADA_EN` guarda la
 * sucursal del farmacéutico **al registrar la venta**, así un cambio posterior de sucursal no
 * mueve la historia (con `TRABAJA_EN`, que es la actual, sí se movería). No filtra por
 * actividad del farmacéutico ni por estado de la venta.
 *
 * @param {{driver: import('neo4j-driver').Driver, neo4jDatabase: string}} context
 * @param {{id_sucursal: string}} params
 * @returns {Promise<{sucursal: object, clientes: object[]}>} Cada cliente con cantidad de
 *   ventas en la sucursal, fecha de la última y farmacéuticos que lo atendieron.
 * @throws {AppError} PARAMETROS_INVALIDOS si falta `id_sucursal`; SUCURSAL_INVALIDA si no existe.
 */
export async function q10({ driver, neo4jDatabase }, params = {}) {
  const { id_sucursal } = params;
  if (typeof id_sucursal !== 'string' || id_sucursal === '') {
    throw new AppError('PARAMETROS_INVALIDOS', 'q10 requiere id_sucursal');
  }
  const [fila] = registros(
    await driver.executeQuery(CYPHER, { id_sucursal }, { database: neo4jDatabase }),
  );
  if (!fila) {
    throw new AppError('SUCURSAL_INVALIDA', `No existe la sucursal ${id_sucursal}`, {
      id_sucursal,
    });
  }
  return fila;
}
