// Restricciones e índices de la proyección en Neo4j.
// Cada etiqueta conserva el ID externo de MongoDB, que es único y sirve para MERGE.
// Las sentencias son constantes (sin valores de usuario) y usan IF NOT EXISTS para ser idempotentes.
export const graphSchema = [
  {
    name: 'cliente_id_unico',
    cypher:
      'CREATE CONSTRAINT cliente_id_unico IF NOT EXISTS FOR (n:Cliente) REQUIRE n.id_cliente IS UNIQUE',
  },
  {
    name: 'receta_id_unico',
    cypher:
      'CREATE CONSTRAINT receta_id_unico IF NOT EXISTS FOR (n:Receta) REQUIRE n.id_receta IS UNIQUE',
  },
  {
    name: 'venta_id_unico',
    cypher:
      'CREATE CONSTRAINT venta_id_unico IF NOT EXISTS FOR (n:Venta) REQUIRE n.id_venta IS UNIQUE',
  },
  {
    name: 'farmaceutico_id_unico',
    cypher:
      'CREATE CONSTRAINT farmaceutico_id_unico IF NOT EXISTS FOR (n:Farmaceutico) REQUIRE n.id_farmaceutico IS UNIQUE',
  },
  {
    name: 'sucursal_id_unico',
    cypher:
      'CREATE CONSTRAINT sucursal_id_unico IF NOT EXISTS FOR (n:Sucursal) REQUIRE n.id_sucursal IS UNIQUE',
  },
  {
    name: 'producto_id_unico',
    cypher:
      'CREATE CONSTRAINT producto_id_unico IF NOT EXISTS FOR (n:Producto) REQUIRE n.id_producto IS UNIQUE',
  },
  // q05 y q12 filtran ventas por período
  {
    name: 'venta_fecha',
    cypher: 'CREATE INDEX venta_fecha IF NOT EXISTS FOR (n:Venta) ON (n.fecha)',
  },
];

/**
 * Crea las restricciones de unicidad y los índices del grafo. Se puede ejecutar varias veces.
 * @param {import('neo4j-driver').Driver} driver
 * @param {string} database Base de Neo4j (`config().neo4jDatabase`).
 */
export async function ensureGraphSchema(driver, database) {
  for (const { cypher } of graphSchema) {
    await driver.executeQuery(cypher, {}, { database });
  }
}
