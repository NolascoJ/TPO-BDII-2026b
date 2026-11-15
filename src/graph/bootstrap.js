import { ensureGraphSchema } from './schema.js';
import {
  proyectarClientes,
  proyectarFarmaceuticos,
  proyectarProductos,
  proyectarRecetas,
  proyectarSucursales,
  proyectarVentas,
} from './proyeccion.js';

// Orden de carga: primero las entidades que otras referencian
const ORDEN = [
  { coleccion: 'sucursales', id: 'id_sucursal', proyectar: proyectarSucursales },
  { coleccion: 'productos', id: 'id_producto', proyectar: proyectarProductos },
  { coleccion: 'clientes', id: 'id_cliente', proyectar: proyectarClientes },
  { coleccion: 'farmaceuticos', id: 'id_farmaceutico', proyectar: proyectarFarmaceuticos },
  { coleccion: 'recetas', id: 'id_receta', proyectar: proyectarRecetas },
  { coleccion: 'ventas', id: 'id_venta', proyectar: proyectarVentas },
];

/**
 * Borra todos los nodos de la proyección (y sus relaciones), en transacciones de a 1000.
 * Solo se usa para reconstruir el grafo desde cero: MongoDB es la fuente de verdad.
 * @param {import('neo4j-driver').Driver} driver
 * @param {string} database
 */
export async function vaciarGrafo(driver, database) {
  const session = driver.session({ database });
  try {
    // CALL ... IN TRANSACTIONS necesita una transacción implícita (session.run)
    await session.run(
      `MATCH (n)
       WHERE n:Cliente OR n:Receta OR n:Venta OR n:Farmaceutico OR n:Sucursal OR n:Producto
       CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS`,
    );
  } finally {
    await session.close();
  }
}

/**
 * Carga inicial reproducible del grafo desde MongoDB.
 *
 * Lee **todas** las entidades proyectadas (incluidas las ventas creadas por q14, no solo las
 * importadas) y las escribe con la misma proyección que usa el aplicador de eventos. Por la
 * guardia de versión es idempotente: repetirla no duplica nodos ni relaciones, y un evento
 * pendiente con una versión ya cargada queda obsoleto. Incluye clientes y farmacéuticos sin
 * ventas. Cada lote se confirma en su propia transacción: si se corta, se puede reejecutar.
 *
 * @param {{db: import('mongodb').Db, driver: import('neo4j-driver').Driver, neo4jDatabase: string}} context
 * @param {{reset?: boolean, lote?: number}} [opciones] `reset` vacía el grafo antes de cargar.
 * @returns {Promise<{reset: boolean, entidades: Record<string, {fuente: number, aplicados: number, sin_cambios: number}>}>}
 */
export async function cargarGrafo(
  { db, driver, neo4jDatabase },
  { reset = false, lote = 500 } = {},
) {
  await ensureGraphSchema(driver, neo4jDatabase);
  if (reset) {
    await vaciarGrafo(driver, neo4jDatabase);
  }

  const session = driver.session({ database: neo4jDatabase });
  const entidades = {};
  try {
    for (const { coleccion, id, proyectar } of ORDEN) {
      const resumen = { fuente: 0, aplicados: 0, sin_cambios: 0 };
      const cursor = db
        .collection(coleccion)
        .find({}, { projection: { _id: 0 } })
        .sort({ [id]: 1 });
      let docs = [];
      const escribir = async () => {
        const resultado = await session.executeWrite((tx) => proyectar(tx, docs));
        resumen.fuente += docs.length;
        resumen.aplicados += resultado.filter((r) => r.aplicado).length;
        resumen.sin_cambios += resultado.filter((r) => !r.aplicado).length;
        docs = [];
      };
      for await (const doc of cursor) {
        docs.push(doc);
        if (docs.length === lote) {
          await escribir();
        }
      }
      if (docs.length > 0) {
        await escribir();
      }
      entidades[coleccion] = resumen;
    }
  } finally {
    await session.close();
  }
  return { reset, entidades };
}
