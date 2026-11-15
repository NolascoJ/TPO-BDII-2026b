import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../../src/config.js';
import { connectMongo, connectNeo4j } from '../../src/db/connections.js';
import { ensureSchema, definitions } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { cargarGrafo } from '../../src/graph/bootstrap.js';
import { errorResult } from '../../src/shared/errors.js';

export const sinId = { projection: { _id: 0 } };
const idsGrafo = [
  'id_cliente',
  'id_receta',
  'id_venta',
  'id_sucursal',
  'id_producto',
  'id_farmaceutico',
];

// Prefija también las referencias de los ítems embebidos.
function prefijar(valor, prefijo) {
  if (Array.isArray(valor)) {
    return valor.map((item) => prefijar(item, prefijo));
  }
  if (valor === null || typeof valor !== 'object' || valor instanceof Date) {
    return valor;
  }
  return Object.fromEntries(
    Object.entries(valor).map(([campo, dato]) => [
      campo,
      campo.startsWith('id_') && typeof dato === 'string'
        ? prefijo + dato
        : prefijar(dato, prefijo),
    ]),
  );
}

/**
 * Carga los CSV en una base temporal y asigna IDs exclusivos a los nodos de la demo.
 * El finally elimina esos recursos; una terminación forzada puede impedir la limpieza.
 */
export async function conDemo({ grafo = false, adicionales = false } = {}, ejecutar) {
  const ejecucion = randomUUID();
  const prefijo = `DEMO-${ejecucion}-`;
  const settings = { ...config(), mongoDatabase: `farmared_demo_${ejecucion.replaceAll('-', '')}` };
  const { client, db } = await connectMongo(settings);
  let driver;
  let salida;
  try {
    await ensureSchema(db);
    await loadData(client, db, { adicionales });
    let cargaGrafo;
    if (grafo) {
      for (const [nombre, definicion] of Object.entries(definitions)) {
        const filas = await db.collection(nombre).find({}, sinId).toArray();
        await db.collection(nombre).bulkWrite(
          filas.map((fila) => ({
            updateOne: {
              filter: { [definicion.id]: fila[definicion.id] },
              update: { $set: prefijar(fila, prefijo) },
            },
          })),
        );
      }
      driver = await connectNeo4j(settings);
      cargaGrafo = await cargarGrafo({ db, driver, neo4jDatabase: settings.neo4jDatabase });
    }
    salida = await ejecutar({
      client,
      db,
      driver,
      settings,
      neo4jDatabase: settings.neo4jDatabase,
      id: (valor) => (grafo ? prefijo + valor : valor),
      cargaGrafo,
    });
    salida = {
      fecha_sistema: new Date(),
      entorno: {
        base_temporal: settings.mongoDatabase,
        prefijo_grafo: grafo ? prefijo : null,
        fuente: adicionales
          ? 'CSV provistos y adicionales; operaciones solo en la copia temporal'
          : 'Los nueve CSV provistos; operaciones de ejemplo solo en la copia temporal',
      },
      ...salida,
    };
  } finally {
    try {
      if (driver) {
        await driver.executeQuery(
          'MATCH (n) WHERE any(k IN $campos WHERE n[k] STARTS WITH $prefijo) DETACH DELETE n',
          { campos: idsGrafo, prefijo },
          { database: settings.neo4jDatabase },
        );
      }
    } finally {
      try {
        await db.dropDatabase();
      } finally {
        try {
          await driver?.close();
        } finally {
          await client.close();
        }
      }
    }
  }
  return { ...salida, recursos_temporales_eliminados: true };
}

export async function snapshotMongo(db) {
  const nombres = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .sort();
  const salida = {};
  for (const nombre of nombres) {
    salida[nombre] = await db.collection(nombre).find().sort({ _id: 1 }).toArray();
  }
  return JSON.stringify(salida);
}

// Un rechazo esperado debe dejar MongoDB sin cambios.
export async function paso({ db, estado, operacion, entrada, errorEsperado }) {
  const antes = await estado();
  const copia = await snapshotMongo(db);
  let resultado;
  try {
    resultado = { ok: true, data: await operacion() };
  } catch (error) {
    if (!errorEsperado || error.code !== errorEsperado) {
      throw error;
    }
    resultado = errorResult(error);
  }
  if (errorEsperado) {
    assert.equal(resultado.error?.code, errorEsperado, 'Debía rechazarse la operación');
  }
  const sinCambios = copia === (await snapshotMongo(db));
  if (errorEsperado) {
    assert.equal(sinCambios, true, 'El rechazo debe dejar la base intacta');
  }
  return { entrada, antes, resultado, despues: await estado(), mongo_sin_cambios: sinCambios };
}

export function campos(documento, nombres) {
  return documento === null || documento === undefined
    ? null
    : Object.fromEntries(nombres.map((nombre) => [nombre, documento[nombre]]));
}

export function resumirCasos(casos, resumirEstado) {
  return Object.fromEntries(
    Object.entries(casos).map(([nombre, caso]) => {
      const resultado = caso.resultado.ok
        ? {
            ok: true,
            // Evita repetir los documentos incluidos en antes/despues.
            data: Object.fromEntries(
              Object.entries(caso.resultado.data).filter(
                ([campo]) => !['cliente', 'venta', 'receta'].includes(campo),
              ),
            ),
          }
        : caso.resultado;
      return [
        nombre,
        {
          ...caso,
          antes: resumirEstado(caso.antes, caso.entrada),
          despues: resumirEstado(caso.despues, caso.entrada),
          resultado,
        },
      ];
    }),
  );
}

// Emite JSON y termina con código 1 ante un error.
export async function mostrarDemo(ejecutar) {
  try {
    assert.equal(process.argv.length, 2, 'La demo no recibe parámetros');
    console.log(JSON.stringify({ ok: true, ...(await ejecutar()) }, null, 2));
  } catch (error) {
    console.error(JSON.stringify(errorResult(error), null, 2));
    process.exitCode = 1;
  }
}
