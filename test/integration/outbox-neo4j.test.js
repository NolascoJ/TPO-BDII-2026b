import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectMongo, connectNeo4j } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { cargarGrafo, vaciarGrafo } from '../../src/graph/bootstrap.js';
import { aplicarEvento } from '../../src/graph/eventos.js';
import { registrarEvento } from '../../src/outbox/registrar.js';
import { procesarOutbox } from '../../src/outbox/procesar.js';
import { q13 } from '../../src/queries/q13.js';
import { q14 } from '../../src/queries/q14.js';
import { diasDesdeHoy, enTransaccion } from './ventas-helpers.js';

// Como neo4j.test.js, requiere un grafo dedicado: lo vacía al iniciar y terminar.
// test:integration ejecuta los archivos en serie para que sus reconstrucciones no se crucen.
test('outbox y CLI con MongoDB y Neo4j reales: entrega, dependencias y recuperación', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  let driver;
  const outbox = db.collection('outbox');
  const alta = (id) =>
    q13(
      { client, db },
      {
        accion: 'alta',
        id_cliente: id,
        datos: {
          nombre: 'Ana',
          apellido: 'Prueba',
          dni: id,
          ciudad: 'Rosario',
          provincia: 'Santa Fe',
          obra_social: 'OSDE',
          nro_afiliado: 'OS-1',
        },
      },
    );
  const cli = (accion, opciones = {}, entorno = {}) => {
    const proceso = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../scripts/outbox.js', import.meta.url)),
        accion,
        JSON.stringify(opciones),
      ],
      {
        env: { ...process.env, MONGODB_DATABASE: settings.mongoDatabase, ...entorno },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    assert.equal(proceso.error, undefined);
    return { status: proceso.status, respuesta: JSON.parse(proceso.stdout || proceso.stderr) };
  };
  const leer = async (cypher, params = {}) =>
    (await driver.executeQuery(cypher, params, { database: settings.neo4jDatabase })).records;
  try {
    driver = await connectNeo4j(settings);
    const contexto = { db, driver, neo4jDatabase: settings.neo4jDatabase };
    await ensureSchema(db);
    await loadData(client, db);
    await cargarGrafo(contexto, { reset: true });

    await t.test('CLI consulta sin Neo4j y entrega el alta de q13 una sola vez', async () => {
      await alta('C-WORKER');
      const estado = cli('estado', {}, { NEO4J_URI: '', NEO4J_USER: '', NEO4J_PASSWORD: '' });
      assert.equal(estado.status, 0);
      assert.equal(estado.respuesta.data.pendientes, 1);
      assert.equal(estado.respuesta.data.eventos_pendientes[0].contenido, undefined);
      const primera = cli('procesar');
      assert.equal(primera.status, 0);
      assert.equal(primera.respuesta.data.procesados, 1);
      assert.equal(cli('procesar').respuesta.data.intentados, 0);
      const [c] = await leer(
        'MATCH (c:Cliente {id_cliente:$id}) RETURN count(c) AS n, max(c.version) AS version',
        { id: 'C-WORKER' },
      );
      assert.equal(c.get('n').toNumber(), 1);
      assert.equal(c.get('version').toNumber(), 1);
    });

    await t.test(
      'eventos de q14 proyectan venta, receta y relaciones sin repetir stock',
      async () => {
        await db
          .collection('stock_lotes')
          .updateMany({}, { $set: { vencimiento: diasDesdeHoy(200) } });
        await q14(
          { client, db },
          {
            id_venta: 'V-WORKER',
            id_cliente: 'C-WORKER',
            id_farmaceutico: 'F001',
            medio_pago: 'Efectivo',
            items: [{ id_producto: 'PRD001', cantidad: 1 }],
          },
        );
        const conReceta = await q14(
          { client, db },
          {
            id_venta: 'V-WORKER-R',
            id_cliente: 'C006',
            id_farmaceutico: 'F001',
            id_receta: 'RC004',
            medio_pago: 'Efectivo',
            items: [{ id_producto: 'PRD003', cantidad: 1 }],
          },
        );
        const stock = await db.collection('stock_lotes').find().sort({ id_lote: 1 }).toArray();
        const r = cli('procesar');
        assert.equal(r.status, 0);
        assert.equal(r.respuesta.data.procesados, 3);
        const [v] =
          await leer(`MATCH (:Cliente {id_cliente:'C006'})-[:REALIZO]->(v:Venta {id_venta:'V-WORKER-R'})-[:USA_RECETA]->(r:Receta)
        RETURN r.dispensas_realizadas AS dispensas, r.version AS version, COUNT { (v)-[:INCLUYE]->() } AS items`);
        assert.equal(v.get('dispensas').toNumber(), conReceta.receta.dispensas_realizadas);
        assert.equal(v.get('version').toNumber(), conReceta.receta.version);
        assert.equal(v.get('items').toNumber(), 1);
        assert.deepEqual(
          await db.collection('stock_lotes').find().sort({ id_lote: 1 }).toArray(),
          stock,
        );
      },
    );

    await t.test(
      'la baja más nueva prevalece sobre versiones viejas y conserva el historial',
      async () => {
        await q13(
          { client, db },
          {
            accion: 'modificar',
            id_cliente: 'C-WORKER',
            datos: { obra_social: 'Sin cobertura', telefono: '1100000000' },
          },
        );
        await q13({ client, db }, { accion: 'baja', id_cliente: 'C-WORKER' });
        assert.equal(cli('procesar', { id_evento: 'cliente:C-WORKER:3' }).status, 0);
        const viejo = cli('procesar', { id_evento: 'cliente:C-WORKER:2' });
        assert.equal(viejo.respuesta.data.resultados[0].estado, 'obsoleto');
        const [c] =
          await leer(`MATCH (c:Cliente {id_cliente:'C-WORKER'}) RETURN c.activo AS activo, c.version AS version,
        c.nro_afiliado AS afiliado, c.telefono AS telefono, COUNT { (c)-[:REALIZO]->() } AS ventas`);
        assert.equal(c.get('activo'), false);
        assert.equal(c.get('version').toNumber(), 3);
        assert.equal(c.get('afiliado'), null);
        assert.equal(c.get('telefono'), '1100000000');
        assert.equal(c.get('ventas').toNumber(), 1);
      },
    );

    await t.test(
      'una dependencia faltante queda pendiente hasta que llega el cliente',
      async () => {
        const base = await db
          .collection('recetas')
          .findOne({ id_receta: 'RC004' }, { projection: { _id: 0 } });
        await enTransaccion(client, (session) =>
          registrarEvento(db, session, {
            tipo_entidad: 'receta',
            id_entidad: 'RC-WORKER',
            version: 1,
            contenido: { ...base, id_receta: 'RC-WORKER', id_cliente: 'C-DEPENDENCIA', version: 1 },
          }),
        );
        const primera = cli('procesar');
        assert.equal(primera.status, 1);
        assert.equal(primera.respuesta.ok, false);
        assert.equal(primera.respuesta.data.resultados[0].reintentable, true);
        assert.match(primera.respuesta.data.resultados[0].error, /DEPENDENCIA_FALTANTE/);
        await alta('C-DEPENDENCIA');
        assert.equal(cli('procesar', { id_evento: 'cliente:C-DEPENDENCIA:1' }).status, 0);
        assert.equal(cli('procesar', { id_evento: 'receta:RC-WORKER:1' }).status, 0);
        const e = await outbox.findOne({ id_evento: 'receta:RC-WORKER:1' });
        assert.equal(e.intentos, 2);
        assert.equal(e.ultimo_error, null);
        const [r] = await leer(
          "MATCH (:Cliente {id_cliente:'C-DEPENDENCIA'})-[:TIENE_RECETA]->(:Receta {id_receta:'RC-WORKER'}) RETURN count(*) AS n",
        );
        assert.equal(r.get('n').toNumber(), 1);
      },
    );

    await t.test(
      'conexión rechazada queda registrada y la CLI permite recuperar el evento',
      async () => {
        await alta('C-CAIDA');
        const opciones = { id_evento: 'cliente:C-CAIDA:1' };
        const caida = cli('procesar', opciones, { NEO4J_URI: 'bolt://127.0.0.1:1' });
        assert.equal(caida.status, 1);
        assert.equal(caida.respuesta.data.fallidos, 1);
        const pendiente = await outbox.findOne(opciones);
        assert.equal(pendiente.estado, 'Pendiente');
        assert.equal(pendiente.intentos, 1);
        assert.ok(pendiente.ultimo_error);
        assert.equal(pendiente.procesado_en, null);
        assert.equal(cli('procesar', opciones).status, 0);
        const confirmado = await outbox.findOne(opciones);
        assert.equal(confirmado.estado, 'Procesado');
        assert.equal(confirmado.intentos, 2);
        assert.equal(confirmado.ultimo_error, null);
      },
    );

    await t.test(
      'respuesta perdida después de confirmar Neo4j se recupera como obsoleto',
      async () => {
        await alta('C-RESPUESTA');
        const opciones = { id_evento: 'cliente:C-RESPUESTA:1' };
        const primera = await procesarOutbox(contexto, opciones, {
          aplicar: async (...args) => {
            await aplicarEvento(...args);
            throw new Error('Respuesta perdida después del commit en Neo4j');
          },
        });
        assert.equal(primera.fallidos, 1);
        assert.equal((await outbox.findOne(opciones)).estado, 'Pendiente');
        const segunda = cli('procesar', opciones);
        assert.equal(segunda.status, 0);
        assert.equal(segunda.respuesta.data.resultados[0].estado, 'obsoleto');
        assert.equal((await outbox.findOne(opciones)).intentos, 2);
        const [c] = await leer("MATCH (c:Cliente {id_cliente:'C-RESPUESTA'}) RETURN count(c) AS n");
        assert.equal(c.get('n').toNumber(), 1);
      },
    );

    await t.test(
      'evento inconsistente queda pendiente con diagnóstico no reintentable',
      async () => {
        await alta('C-INVALIDO');
        const opciones = { id_evento: 'cliente:C-INVALIDO:1' };
        await outbox.updateOne(opciones, { $set: { 'contenido.version': 9 } });
        const invalido = cli('procesar', opciones);
        assert.equal(invalido.status, 1);
        assert.equal(invalido.respuesta.data.resultados[0].reintentable, false);
        assert.match((await outbox.findOne(opciones)).ultimo_error, /EVENTO_INVALIDO/);
        assert.equal(
          (await leer("MATCH (c:Cliente {id_cliente:'C-INVALIDO'}) RETURN c")).length,
          0,
        );
        // Corrección de la fixture dañada: el siguiente intento debe funcionar.
        await outbox.updateOne(opciones, { $set: { 'contenido.version': 1 } });
        assert.equal(cli('procesar', opciones).status, 0);
        assert.equal(cli('estado').respuesta.data.pendientes, 0);
      },
    );

    await t.test('la CLI rechaza opciones inválidas antes de conectarse', () => {
      const r = cli('procesar', { limite: 0 }, { MONGODB_URI: '', NEO4J_URI: '' });
      assert.equal(r.status, 1);
      assert.equal(r.respuesta.error.code, 'PARAMETROS_INVALIDOS');
    });
  } finally {
    try {
      if (driver) {
        await vaciarGrafo(driver, settings.neo4jDatabase);
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
