import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config.js';
import { connectMongo, connectNeo4j } from '../../src/db/connections.js';
import { registros } from '../../src/graph/valores.js';
import { conDemo } from '../../scripts/lib/demo.js';

// Requiere una base Neo4j de pruebas.
test('demos: ejecución, limpieza y aislamiento de recursos', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  let driver;
  const marca = randomUUID();
  const ejecutar = (nombre) => {
    const proceso = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`../../scripts/${nombre}.js`, import.meta.url))],
      {
        env: { ...process.env, MONGODB_DATABASE: settings.mongoDatabase },
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    assert.equal(proceso.error, undefined);
    assert.equal(proceso.status, 0, proceso.stderr);
    const salida = JSON.parse(proceso.stdout);
    assert.equal(salida.ok, true);
    assert.equal(salida.recursos_temporales_eliminados, true);
    return salida;
  };
  const existeBase = async (nombre) =>
    (await db.admin().listDatabases({ nameOnly: true })).databases.some((d) => d.name === nombre);
  try {
    driver = await connectNeo4j(settings);
    const leer = async (query, params = {}) =>
      registros(await driver.executeQuery(query, params, { database: settings.neo4jDatabase }));
    // Los IDs sin prefijo deben sobrevivir a la limpieza de la demo.
    await leer(
      `MERGE (c:Cliente {id_cliente:'C001'}) ON CREATE SET c.marca_demo_test=$marca, c.version=999
      MERGE (v:Venta {id_venta:'V001'}) ON CREATE SET v.marca_demo_test=$marca, v.version=999
      MERGE (c)-[:REALIZO]->(v)`,
      { marca },
    );
    await db.collection('testigo').insertOne({ valor: marca });
    const estadoGrafo = async () => ({
      nodos: await leer(
        'MATCH (n) RETURN elementId(n) AS id, labels(n) AS etiquetas, properties(n) AS propiedades ORDER BY id',
      ),
      relaciones: await leer(
        'MATCH (a)-[r]->(b) RETURN elementId(r) AS id, elementId(a) AS origen, elementId(b) AS destino, type(r) AS tipo, properties(r) AS propiedades ORDER BY id',
      ),
    });
    const antes = await estadoGrafo();

    await t.test('los tres comandos emiten JSON y limpian sus recursos', async () => {
      for (const nombre of ['demo-consultas', 'demo-q13', 'demo-outbox']) {
        const salida = ejecutar(nombre);
        assert.equal(await existeBase(salida.entorno.base_temporal), false);
        assert.deepEqual(await estadoGrafo(), antes);
        assert.equal((await db.collection('testigo').findOne({})).valor, marca);
      }
    });

    await t.test(
      'una excepción también limpia los recursos de la demo sin borrar datos ajenos',
      async () => {
        let nombre;
        const fallo = new Error('Interrupción controlada de la demo');
        await assert.rejects(
          conDemo({ grafo: true }, async (ctx) => {
            nombre = ctx.settings.mongoDatabase;
            throw fallo;
          }),
          (error) => error === fallo,
        );
        assert.equal(await existeBase(nombre), false);
        assert.deepEqual(await estadoGrafo(), antes);
        assert.equal((await db.collection('testigo').findOne({})).valor, marca);
      },
    );
  } finally {
    try {
      if (driver) {
        await driver.executeQuery(
          'MATCH (n {marca_demo_test:$marca}) DETACH DELETE n',
          { marca },
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
});
