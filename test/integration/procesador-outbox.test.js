import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { procesarOutbox, consultarOutbox } from '../../src/outbox/procesar.js';
import { AppError } from '../../src/shared/errors.js';
import { snapshot } from './ventas-helpers.js';

test('procesador con MongoDB real: lotes, fallos, reintentos y confirmación', async (t) => {
  const { client, db } = await connectMongo({
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  });
  const outbox = db.collection('outbox');
  const sembrar = async (...ids) => {
    await outbox.deleteMany({});
    if (ids.length) {
      await outbox.insertMany(
        ids.map((id) => ({
          id_evento: `cliente:${id}:1`,
          tipo_entidad: 'cliente',
          id_entidad: id,
          version: 1,
          contenido: { id_cliente: id, version: 1 },
          estado: 'Pendiente',
          intentos: 0,
          creado_en: new Date('2026-11-01T00:00:00Z'),
          ultimo_error: null,
          procesado_en: null,
        })),
      );
    }
  };
  const evento = (id) => outbox.findOne({ id_entidad: id });
  const procesar = (aplicar, opciones = {}, base = db) =>
    procesarOutbox({ db: base, driver: 'driver', neo4jDatabase: 'neo4j' }, opciones, { aplicar });
  // Inyecta fallas de escritura sin modificar el driver real ni su estado global.
  const conFalla = (debeFallar, error) => ({
    collection(nombre) {
      assert.equal(nombre, 'outbox');
      return new Proxy(outbox, {
        get(target, propiedad) {
          if (propiedad === 'updateOne') {
            return async (filtro, actualizacion) => {
              if (debeFallar(actualizacion)) {
                throw error;
              }
              return target.updateOne(filtro, actualizacion);
            };
          }
          const valor = Reflect.get(target, propiedad);
          return typeof valor === 'function' ? valor.bind(target) : valor;
        },
      });
    },
  });
  try {
    await ensureSchema(db);
    await loadData(client, db);
    const negocioAntes = await snapshot(db);
    delete negocioAntes.outbox;

    await t.test('cola vacía no llama al grafo', async () => {
      const r = await procesar(() => assert.fail('No hay eventos'));
      assert.deepEqual(r, {
        seleccionados: 0,
        intentados: 0,
        procesados: 0,
        fallidos: 0,
        omitidos: 0,
        resultados: [],
        pendientes: 0,
      });
    });

    await t.test(
      'ordena por fecha e ID, respeta límite y marca solo después de aplicar',
      async () => {
        await sembrar('C', 'B', 'A');
        await outbox.updateOne(
          { id_entidad: 'C' },
          { $set: { creado_en: new Date('2026-10-31T23:59:59Z') } },
        );
        const vistos = [];
        const r = await procesar(
          async (driver, database, e) => {
            assert.equal(driver, 'driver');
            assert.equal(database, 'neo4j');
            const pendiente = await evento(e.id_entidad);
            assert.equal(pendiente.estado, 'Pendiente');
            assert.equal(pendiente.procesado_en, null);
            assert.equal(pendiente.intentos, 1);
            vistos.push(e.id_entidad);
            return { estado: 'aplicado' };
          },
          { limite: 2 },
        );
        assert.deepEqual(vistos, ['C', 'A']);
        assert.equal(r.procesados, 2);
        assert.equal(r.pendientes, 1);
        assert.equal((await evento('A')).estado, 'Procesado');
        assert.ok((await evento('A')).procesado_en instanceof Date);
        assert.deepEqual((await evento('A')).contenido, { id_cliente: 'A', version: 1 });
        assert.equal((await evento('B')).intentos, 0);
      },
    );

    await t.test('un error no impide procesar el resto y se reintenta por ID', async () => {
      await sembrar('A', 'B');
      const falla = new AppError('DEPENDENCIA_FALTANTE', 'Falta cliente', { reintentable: true });
      const r = await procesar(async (_d, _b, e) => {
        if (e.id_entidad === 'A') {
          throw falla;
        }
        return { estado: 'aplicado' };
      });
      assert.equal(r.fallidos, 1);
      assert.equal(r.procesados, 1);
      assert.equal(r.resultados[0].reintentable, true);
      const a = await evento('A');
      assert.equal(a.estado, 'Pendiente');
      assert.equal(a.intentos, 1);
      assert.equal(a.ultimo_error, 'DEPENDENCIA_FALTANTE: Falta cliente');
      assert.equal(a.procesado_en, null);
      const b = await evento('B');
      const segundo = await procesar(async () => ({ estado: 'aplicado' }), {
        id_evento: a.id_evento,
      });
      assert.equal(segundo.procesados, 1);
      assert.equal((await evento('A')).intentos, 2);
      assert.equal((await evento('A')).ultimo_error, null);
      assert.deepEqual(await evento('B'), b);
      assert.equal((await procesar(() => assert.fail('Todos procesados'))).intentados, 0);
    });

    await t.test(
      'un pendiente fallido no bloquea los siguientes cuando el lote es pequeño',
      async () => {
        await sembrar('A', 'B');
        let dependenciaDisponible = false;
        const vistos = [];
        const aplicar = async (_driver, _database, e) => {
          vistos.push(e.id_entidad);
          if (e.id_entidad === 'A' && !dependenciaDisponible) {
            throw new AppError('DEPENDENCIA_FALTANTE', 'Primero debe procesarse B');
          }
          if (e.id_entidad === 'B') {
            dependenciaDisponible = true;
          }
          return { estado: 'aplicado' };
        };
        assert.equal((await procesar(aplicar, { limite: 1 })).fallidos, 1);
        const estado = await consultarOutbox({ db });
        assert.deepEqual(
          estado.eventos_pendientes.map((e) => e.id_entidad),
          ['B', 'A'],
        );
        assert.equal((await procesar(aplicar, { limite: 1 })).procesados, 1);
        assert.equal((await evento('B')).estado, 'Procesado');
        assert.equal((await procesar(aplicar, { limite: 1 })).procesados, 1);
        assert.deepEqual(vistos, ['A', 'B', 'A']);
        assert.equal((await evento('A')).intentos, 2);
        assert.equal((await evento('B')).intentos, 1);
        assert.equal(await outbox.countDocuments({ estado: 'Pendiente' }), 0);
      },
    );

    await t.test(
      'eventos inválidos y respuestas desconocidas quedan pendientes y diagnosticados',
      async () => {
        await sembrar('A', 'B');
        const r = await procesar(async (_d, _b, e) => {
          if (e.id_entidad === 'A') {
            throw new AppError('EVENTO_INVALIDO', 'Contenido incorrecto', { reintentable: false });
          }
          return { estado: 'desconocido' };
        });
        assert.equal(r.fallidos, 2);
        assert.ok(r.resultados.every((e) => e.reintentable === false));
        assert.equal((await evento('A')).estado, 'Pendiente');
        assert.match((await evento('B')).ultimo_error, /RESULTADO_INVALIDO/);
        const estado = await consultarOutbox({ db }, { limite: 1 });
        assert.equal(estado.pendientes, 2);
        assert.equal(estado.con_error, 2);
        assert.equal(estado.eventos_pendientes.length, 1);
        assert.equal(estado.eventos_pendientes[0].contenido, undefined);
        assert.equal(estado.eventos_pendientes[0]._id, undefined);
        assert.equal((await consultarOutbox({ db }, { id_evento: 'cliente:B:1' })).pendientes, 1);
      },
    );

    await t.test('confirmación perdida: el reintento obsoleto completa la marca', async () => {
      await sembrar('A', 'B');
      let aplicado = false;
      const aplicar = async () => {
        const estado = aplicado ? 'obsoleto' : 'aplicado';
        aplicado = true;
        return { estado };
      };
      const error = new Error('MongoDB no confirmó la marca');
      await assert.rejects(
        procesar(
          aplicar,
          {},
          conFalla((u) => u.$set?.estado === 'Procesado', error),
        ),
        (e) => e === error,
      );
      assert.equal(aplicado, true);
      assert.equal((await evento('A')).estado, 'Pendiente');
      assert.equal((await evento('B')).intentos, 0);
      const r = await procesar(aplicar, { id_evento: 'cliente:A:1' });
      assert.equal(r.resultados[0].estado, 'obsoleto');
      assert.equal((await evento('A')).estado, 'Procesado');
      assert.equal((await evento('A')).intentos, 2);
    });

    await t.test(
      'si falla MongoDB al iniciar o registrar un error, el lote se detiene',
      async () => {
        await sembrar('A', 'B');
        const fallo = new Error('MongoDB no disponible');
        await assert.rejects(
          procesar(
            () => assert.fail('No debe llamar al grafo'),
            {},
            conFalla((u) => Boolean(u.$inc), fallo),
          ),
          (e) => e === fallo,
        );
        assert.equal((await evento('A')).intentos, 0);
        await assert.rejects(
          procesar(
            async () => {
              throw new Error('Neo4j caído');
            },
            {},
            conFalla((u) => Boolean(u.$set?.ultimo_error), fallo),
          ),
          (e) => e === fallo,
        );
        assert.equal((await evento('A')).estado, 'Pendiente');
        assert.equal((await evento('B')).intentos, 0);
      },
    );

    await t.test('el procesamiento no cambia entidades de negocio', async () => {
      const negocioDespues = await snapshot(db);
      delete negocioDespues.outbox;
      assert.deepEqual(negocioDespues, negocioAntes);
    });
  } finally {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  }
});
