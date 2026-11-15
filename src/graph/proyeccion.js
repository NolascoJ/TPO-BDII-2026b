import { AppError } from '../shared/errors.js';
import {
  mapCliente,
  mapFarmaceutico,
  mapProducto,
  mapReceta,
  mapSucursal,
  mapVenta,
} from './mapeo.js';

// Escritura de la proyección en Neo4j. La usan la carga inicial y el aplicador de eventos,
// para que haya un solo lugar que decida cómo se proyecta cada entidad.
//
// Reglas comunes:
// - MERGE por el ID externo de MongoDB (hay restricción de unicidad por etiqueta).
// - Guardia de versión: solo se escribe si el nodo es nuevo o la versión recibida es mayor.
//   Una versión igual o menor no cambia nada (evento repetido u obsoleto).
// - Al aplicar, las propiedades se reemplazan con valores absolutos (`SET n = props`) y las
//   relaciones salientes de la entidad se reemplazan, sin acumular vínculos viejos.
// - Las entidades referenciadas tienen que existir: si falta alguna se lanza
//   DEPENDENCIA_FALTANTE antes de escribir, para no crear nodos fantasma.
// - Nunca se borran nodos: una baja lógica es solo `activo = false`.
//
// Cada función recibe una transacción de Neo4j (`session.executeWrite`) y documentos con la
// forma de MongoDB. Devuelve `[{id, aplicado}]`, uno por documento.

const DEPENDENCIAS = {
  Cliente:
    'UNWIND $ids AS id OPTIONAL MATCH (n:Cliente {id_cliente: id}) WITH id, n WHERE n IS NULL RETURN collect(id) AS faltantes',
  Farmaceutico:
    'UNWIND $ids AS id OPTIONAL MATCH (n:Farmaceutico {id_farmaceutico: id}) WITH id, n WHERE n IS NULL RETURN collect(id) AS faltantes',
  Sucursal:
    'UNWIND $ids AS id OPTIONAL MATCH (n:Sucursal {id_sucursal: id}) WITH id, n WHERE n IS NULL RETURN collect(id) AS faltantes',
  Receta:
    'UNWIND $ids AS id OPTIONAL MATCH (n:Receta {id_receta: id}) WITH id, n WHERE n IS NULL RETURN collect(id) AS faltantes',
  Producto:
    'UNWIND $ids AS id OPTIONAL MATCH (n:Producto {id_producto: id}) WITH id, n WHERE n IS NULL RETURN collect(id) AS faltantes',
};

async function verificarDependencias(tx, requeridas) {
  const faltantes = {};
  for (const [label, ids] of Object.entries(requeridas)) {
    const unicos = [...new Set(ids.filter((id) => id !== null && id !== undefined))];
    if (unicos.length === 0) {
      continue;
    }
    const { records } = await tx.run(DEPENDENCIAS[label], { ids: unicos });
    const lista = records[0].get('faltantes');
    if (lista.length > 0) {
      faltantes[label] = lista;
    }
  }
  if (Object.keys(faltantes).length > 0) {
    throw new AppError('DEPENDENCIA_FALTANTE', 'Faltan nodos referenciados en el grafo', {
      faltantes,
    });
  }
}

async function ejecutar(tx, cypher, filas) {
  if (filas.length === 0) {
    return [];
  }
  const { records } = await tx.run(cypher, { filas });
  return records.map((record) => ({ id: record.get('id'), aplicado: record.get('aplicado') }));
}

// Entidades sin relaciones salientes: Cliente, Sucursal, Producto
const SIN_RELACIONES = (label, idProp) => `
UNWIND $filas AS f
MERGE (n:${label} {${idProp}: f.props.${idProp}})
WITH n, f, (n.version IS NULL OR n.version < f.props.version) AS aplicado
CALL (n, f, aplicado) {
  WITH n, f WHERE aplicado
  SET n = f.props
}
RETURN f.props.${idProp} AS id, aplicado`;

const CYPHER_CLIENTE = SIN_RELACIONES('Cliente', 'id_cliente');
const CYPHER_SUCURSAL = SIN_RELACIONES('Sucursal', 'id_sucursal');
const CYPHER_PRODUCTO = SIN_RELACIONES('Producto', 'id_producto');

// TRABAJA_EN representa la sucursal actual; las ventas guardan la histórica en REGISTRADA_EN
const CYPHER_FARMACEUTICO = `
UNWIND $filas AS f
MERGE (n:Farmaceutico {id_farmaceutico: f.props.id_farmaceutico})
WITH n, f, (n.version IS NULL OR n.version < f.props.version) AS aplicado
CALL (n, f, aplicado) {
  WITH n, f WHERE aplicado
  SET n = f.props
  WITH n, f
  OPTIONAL MATCH (n)-[r:TRABAJA_EN]->()
  DELETE r
  WITH DISTINCT n, f
  MATCH (s:Sucursal {id_sucursal: f.id_sucursal})
  MERGE (n)-[:TRABAJA_EN]->(s)
}
RETURN f.props.id_farmaceutico AS id, aplicado`;

const CYPHER_RECETA = `
UNWIND $filas AS f
MERGE (n:Receta {id_receta: f.props.id_receta})
WITH n, f, (n.version IS NULL OR n.version < f.props.version) AS aplicado
CALL (n, f, aplicado) {
  WITH n, f WHERE aplicado
  SET n = f.props
  WITH n, f
  OPTIONAL MATCH ()-[r:TIENE_RECETA]->(n)
  DELETE r
  WITH DISTINCT n, f
  MATCH (c:Cliente {id_cliente: f.id_cliente})
  MERGE (c)-[:TIENE_RECETA]->(n)
}
RETURN f.props.id_receta AS id, aplicado`;

const CYPHER_VENTA = `
UNWIND $filas AS f
MERGE (v:Venta {id_venta: f.props.id_venta})
WITH v, f, (v.version IS NULL OR v.version < f.props.version) AS aplicado
CALL (v, f, aplicado) {
  WITH v, f WHERE aplicado
  SET v = f.props
  WITH v, f
  OPTIONAL MATCH (v)-[r:ATENDIDA_POR|REGISTRADA_EN|USA_RECETA|INCLUYE]->()
  DELETE r
  WITH DISTINCT v, f
  OPTIONAL MATCH ()-[r:REALIZO]->(v)
  DELETE r
  WITH DISTINCT v, f
  MATCH (c:Cliente {id_cliente: f.id_cliente})
  MATCH (fa:Farmaceutico {id_farmaceutico: f.id_farmaceutico})
  MATCH (s:Sucursal {id_sucursal: f.id_sucursal})
  MERGE (c)-[:REALIZO]->(v)
  MERGE (v)-[:ATENDIDA_POR]->(fa)
  MERGE (v)-[:REGISTRADA_EN]->(s)
  WITH v, f
  OPTIONAL MATCH (rc:Receta {id_receta: f.id_receta})
  FOREACH (_ IN CASE WHEN rc IS NULL THEN [] ELSE [1] END | MERGE (v)-[:USA_RECETA]->(rc))
  WITH v, f
  UNWIND f.items AS item
  MATCH (p:Producto {id_producto: item.id_producto})
  CREATE (v)-[:INCLUYE {
    id_detalle: item.id_detalle,
    cantidad: item.cantidad,
    precio_unit: item.precio_unit
  }]->(p)
}
RETURN f.props.id_venta AS id, aplicado`;

export async function proyectarClientes(tx, docs) {
  return ejecutar(tx, CYPHER_CLIENTE, docs.map(mapCliente));
}

export async function proyectarSucursales(tx, docs) {
  return ejecutar(tx, CYPHER_SUCURSAL, docs.map(mapSucursal));
}

export async function proyectarProductos(tx, docs) {
  return ejecutar(tx, CYPHER_PRODUCTO, docs.map(mapProducto));
}

export async function proyectarFarmaceuticos(tx, docs) {
  const filas = docs.map(mapFarmaceutico);
  await verificarDependencias(tx, { Sucursal: filas.map((f) => f.id_sucursal) });
  return ejecutar(tx, CYPHER_FARMACEUTICO, filas);
}

export async function proyectarRecetas(tx, docs) {
  const filas = docs.map(mapReceta);
  await verificarDependencias(tx, { Cliente: filas.map((f) => f.id_cliente) });
  return ejecutar(tx, CYPHER_RECETA, filas);
}

export async function proyectarVentas(tx, docs) {
  const filas = docs.map(mapVenta);
  await verificarDependencias(tx, {
    Cliente: filas.map((f) => f.id_cliente),
    Farmaceutico: filas.map((f) => f.id_farmaceutico),
    Sucursal: filas.map((f) => f.id_sucursal),
    Receta: filas.map((f) => f.id_receta),
    Producto: filas.flatMap((f) => f.items.map((item) => item.id_producto)),
  });
  return ejecutar(tx, CYPHER_VENTA, filas);
}
