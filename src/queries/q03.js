import { AppError } from '../shared/errors.js';
import { registros } from '../graph/valores.js';

// Ventas (con farmacéutico, sucursal de la venta, receta e ítems) y recetas del cliente.
// Orden cronológico: fecha de la venta o de emisión de la receta; ante la misma fecha, la
// receta primero (se emite antes de dispensarse) y después por ID.
const CYPHER = `
MATCH (c:Cliente {id_cliente: $id_cliente})
WITH c,
  COLLECT {
    MATCH (c)-[:REALIZO]->(v:Venta)
    OPTIONAL MATCH (v)-[:ATENDIDA_POR]->(f:Farmaceutico)
    OPTIONAL MATCH (v)-[:REGISTRADA_EN]->(s:Sucursal)
    OPTIONAL MATCH (v)-[:USA_RECETA]->(r:Receta)
    RETURN {
      evento: 'venta', fecha: v.fecha, orden: 1, id: v.id_venta,
      id_venta: v.id_venta, tipo: v.tipo, estado: v.estado, medio_pago: v.medio_pago,
      total: v.total, id_receta: r.id_receta,
      farmaceutico: f {.id_farmaceutico, .nombre, .apellido, .matricula, .activo},
      sucursal: s {.id_sucursal, .nombre},
      items: COLLECT {
        MATCH (v)-[i:INCLUYE]->(p:Producto)
        RETURN {id_detalle: i.id_detalle, id_producto: p.id_producto, nombre: p.nombre,
                cantidad: i.cantidad, precio_unit: i.precio_unit}
        ORDER BY i.id_detalle
      }
    }
  } +
  COLLECT {
    MATCH (c)-[:TIENE_RECETA]->(r:Receta)
    RETURN {
      evento: 'receta', fecha: r.fecha_emision, orden: 0, id: r.id_receta,
      id_receta: r.id_receta, tipo: r.tipo, estado: r.estado, medico: r.medico,
      dispensas_autorizadas: r.dispensas_autorizadas,
      dispensas_realizadas: r.dispensas_realizadas, proxima_dispensa: r.proxima_dispensa
    }
  } AS eventos
CALL (eventos) {
  UNWIND eventos AS e
  WITH e ORDER BY e.fecha, e.orden, e.id
  RETURN collect(e) AS historial
}
RETURN c {.id_cliente, .nombre, .apellido, .dni, .obra_social, .activo} AS cliente, historial`;

/**
 * q03: historial completo de un cliente (Neo4j): ventas y recetas en orden cronológico.
 *
 * Recorre `(Cliente)-[:REALIZO]->(Venta)` y `(Cliente)-[:TIENE_RECETA]->(Receta)`; de cada
 * venta agrega farmacéutico (`ATENDIDA_POR`), sucursal donde se hizo (`REGISTRADA_EN`),
 * receta usada (`USA_RECETA`) e ítems (`INCLUYE` → `Producto`). Incluye ventas en cualquier
 * estado: es el historial completo.
 *
 * @param {{driver: import('neo4j-driver').Driver, neo4jDatabase: string}} context
 * @param {{id_cliente: string}} params
 * @returns {Promise<{cliente: object, historial: object[]}>} Cada elemento del historial tiene
 *   `evento` ('venta' | 'receta') y `fecha`.
 * @throws {AppError} PARAMETROS_INVALIDOS si falta `id_cliente`; CLIENTE_INVALIDO si no existe.
 */
export async function q03({ driver, neo4jDatabase }, params = {}) {
  const { id_cliente } = params;
  if (typeof id_cliente !== 'string' || id_cliente === '') {
    throw new AppError('PARAMETROS_INVALIDOS', 'q03 requiere id_cliente');
  }
  const [fila] = registros(
    await driver.executeQuery(CYPHER, { id_cliente }, { database: neo4jDatabase }),
  );
  if (!fila) {
    throw new AppError('CLIENTE_INVALIDO', `No existe el cliente ${id_cliente}`, { id_cliente });
  }
  // Se quitan las claves auxiliares que solo sirven para ordenar
  const historial = fila.historial.map(({ orden: _o, id: _i, ...evento }) => evento);
  return { cliente: fila.cliente, historial };
}
