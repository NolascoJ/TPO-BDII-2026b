import assert from 'node:assert/strict';
import { q13 } from '../src/queries/q13.js';
import { q14 } from '../src/queries/q14.js';
import { q03 } from '../src/queries/q03.js';
import { crearDriverNeo4j } from '../src/db/connections.js';
import { aplicarEvento } from '../src/graph/eventos.js';
import { cargarGrafo } from '../src/graph/bootstrap.js';
import { registros } from '../src/graph/valores.js';
import { procesarOutbox, consultarOutbox } from '../src/outbox/procesar.js';
import { inicioDiaUTC, sumarDiasUTC } from '../src/services/venta/fechas.js';
import { conDemo, paso, sinId, mostrarDemo, campos, resumirCasos } from './lib/demo.js';

// Ajusta vencimientos en la base temporal para demostrar FEFO con stock vigente.
await mostrarDemo(() =>
  conDemo({ grafo: true }, async (ctx) => {
    const { db, driver, neo4jDatabase, id, settings } = ctx;
    const casos = {};
    const hoy = inicioDiaUTC(new Date());
    const ajustes = [
      { id_lote: id('L005'), vencimiento: sumarDiasUTC(hoy, 10) },
      { id_lote: id('L015'), vencimiento: sumarDiasUTC(hoy, 200) },
    ];
    for (const { id_lote, vencimiento } of ajustes) {
      await db.collection('stock_lotes').updateOne({ id_lote }, { $set: { vencimiento } });
    }
    const segundaCarga = await cargarGrafo(ctx);
    assert.ok(Object.values(segundaCarga.entidades).every((c) => c.aplicados === 0));
    const clientes = [id('C006'), id('C-DEMO')];
    const estado = async (entrada) => ({
      mongo: {
        clientes: await db
          .collection('clientes')
          .find({ id_cliente: { $in: clientes } }, sinId)
          .sort({ id_cliente: 1 })
          .toArray(),
        receta: await db.collection('recetas').findOne({ id_receta: id('RC004') }, sinId),
        venta: await db
          .collection('ventas')
          .findOne({ id_venta: entrada.id_venta ?? id('V-DEMO') }, sinId),
        lotes: await db
          .collection('stock_lotes')
          .find({ id_lote: { $in: ajustes.map((l) => l.id_lote) } }, sinId)
          .sort({ id_lote: 1 })
          .toArray(),
        eventos: await db.collection('outbox').find({}, sinId).sort({ id_evento: 1 }).toArray(),
      },
      grafo: registros(
        await driver.executeQuery(
          `MATCH (c:Cliente) WHERE c.id_cliente IN $ids
       RETURN properties(c) AS cliente,
         COUNT { (c)-[:REALIZO]->() } AS cantidad_ventas,
         [(c)-[:TIENE_RECETA]->(r) | r {.id_receta, .version, .dispensas_realizadas, .estado}] AS recetas
       ORDER BY c.id_cliente`,
          { ids: clientes },
          { database: neo4jDatabase },
        ),
      ),
    });
    const capturar = (entrada, operacion, errorEsperado) =>
      paso({ db, estado: () => estado(entrada), entrada, operacion, errorEsperado });
    const procesar = async (nombre, opciones = {}, contexto = ctx, dependencias) => {
      casos[nombre] = await capturar({ operacion: 'procesarOutbox', opciones }, () =>
        procesarOutbox(contexto, opciones, dependencias),
      );
      return casos[nombre].resultado.data;
    };
    const alta = {
      accion: 'alta',
      id_cliente: id('C-DEMO'),
      datos: {
        nombre: 'Ana',
        apellido: 'Demostración',
        dni: '00999002',
        ciudad: 'Rosario',
        provincia: 'Santa Fe',
      },
    };
    casos.alta_q13 = await capturar(alta, () => q13(ctx, alta));
    casos.dni_duplicado = await capturar(
      { ...alta, id_cliente: id('C-DUP') },
      () => q13(ctx, { ...alta, id_cliente: id('C-DUP') }),
      'DNI_DUPLICADO',
    );
    const eventoAlta = `cliente:${alta.id_cliente}:1`;

    // Puerto cerrado para provocar un error de conexión.
    const sinConexion = crearDriverNeo4j(
      { ...settings, neo4jUri: 'bolt://127.0.0.1:1' },
      {
        maxTransactionRetryTime: 0,
        connectionAcquisitionTimeout: 3000,
      },
    );
    try {
      const fallo = await procesar(
        'conexion_rechazada',
        { id_evento: eventoAlta },
        { ...ctx, driver: sinConexion },
      );
      casos.conexion_rechazada.falla_provocada =
        'Destino de prueba bolt://127.0.0.1:1; no se detuvo el Neo4j real';
      assert.equal(fallo.fallidos, 1);
      assert.equal(casos.conexion_rechazada.despues.mongo.eventos[0].estado, 'Pendiente');
    } finally {
      await sinConexion.close();
    }
    assert.equal(
      (await procesar('recuperacion_conexion', { id_evento: eventoAlta })).procesados,
      1,
    );
    assert.equal(
      casos.recuperacion_conexion.despues.grafo.find(
        (c) => c.cliente.id_cliente === alta.id_cliente,
      ).cliente.version,
      1,
    );

    const venta = {
      id_venta: id('V-DEMO'),
      id_cliente: id('C006'),
      id_farmaceutico: id('F001'),
      id_receta: id('RC004'),
      medio_pago: 'Obra social',
      items: [{ id_producto: id('PRD003'), cantidad: 50 }],
    };
    casos.venta_q14_q15 = await capturar(venta, () => q14(ctx, venta));
    assert.deepEqual(
      casos.venta_q14_q15.resultado.data.movimientos.map((m) => [m.id_lote, m.descontar]),
      [
        [id('L005'), 40],
        [id('L015'), 10],
      ],
    );
    assert.equal((await procesar('sincronizacion_venta_receta')).procesados, 2);
    assert.deepEqual(
      casos.sincronizacion_venta_receta.antes.mongo.lotes,
      casos.sincronizacion_venta_receta.despues.mongo.lotes,
    );
    const historial = await q03(ctx, { id_cliente: id('C006') });
    assert.equal(historial.historial.filter((e) => e.id_venta === venta.id_venta).length, 1);
    casos.reintento_venta = await capturar(venta, () => q14(ctx, venta));
    assert.equal(casos.reintento_venta.resultado.data.ya_registrada, true);
    assert.equal(casos.reintento_venta.mongo_sin_cambios, true);
    const sinStock = {
      ...venta,
      id_venta: id('V-SIN-STOCK'),
      items: [{ id_producto: id('PRD003'), cantidad: 1000 }],
    };
    casos.rechazo_stock = await capturar(sinStock, () => q14(ctx, sinStock), 'STOCK_INSUFICIENTE');
    assert.equal(casos.rechazo_stock.antes.mongo.venta, null);
    assert.equal(casos.rechazo_stock.despues.mongo.venta, null);

    const cambio = {
      accion: 'modificar',
      id_cliente: id('C006'),
      datos: { telefono: '1100000000', obra_social: 'Sin cobertura' },
    };
    casos.modificacion_q13 = await capturar(cambio, () => q13(ctx, cambio));
    const baja = { accion: 'baja', id_cliente: id('C006') };
    casos.baja_q13 = await capturar(baja, () => q13(ctx, baja));
    assert.equal(
      (await procesar('baja_version_3', { id_evento: `cliente:${id('C006')}:3` })).procesados,
      1,
    );
    assert.equal(
      (await procesar('version_2_fuera_de_orden', { id_evento: `cliente:${id('C006')}:2` }))
        .resultados[0].estado,
      'obsoleto',
    );
    const despuesBaja = await q03(ctx, { id_cliente: id('C006') });
    assert.equal(despuesBaja.cliente.activo, false);
    assert.deepEqual(despuesBaja.historial, historial.historial);

    const contacto = {
      accion: 'modificar',
      id_cliente: alta.id_cliente,
      datos: { email: 'demo@example.test' },
    };
    casos.contacto_q13 = await capturar(contacto, () => q13(ctx, contacto));
    const idContacto = `cliente:${alta.id_cliente}:2`;
    const perdido = await procesar('respuesta_perdida', { id_evento: idContacto }, ctx, {
      aplicar: async (...args) => {
        await aplicarEvento(...args);
        throw new Error('Falla simulada: respuesta perdida tras confirmar Neo4j');
      },
    });
    casos.respuesta_perdida.falla_provocada =
      'Se aplica realmente el evento y luego se lanza un error para simular pérdida de respuesta';
    assert.equal(perdido.fallidos, 1);
    assert.equal(
      (await procesar('recuperacion_respuesta', { id_evento: idContacto })).resultados[0].estado,
      'obsoleto',
    );
    const final = await consultarOutbox(ctx);
    assert.equal(final.pendientes, 0);
    assert.equal((await procesarOutbox(ctx)).intentados, 0);
    return {
      ajustes_solo_en_copia_temporal: ajustes,
      carga_inicial: ctx.cargaGrafo,
      repeticion_carga: segundaCarga,
      formato_evidencia:
        'Estado resumido según la operación: cliente, venta/receta/stock o eventos/grafo; se verifican los documentos completos',
      casos: resumirCasos(casos, ({ mongo, grafo }, entrada) => {
        const eventos = mongo.eventos
          .filter((e) => {
            if (entrada.accion) {
              return e.id_entidad === entrada.id_cliente;
            }
            if (entrada.operacion) {
              return !entrada.opciones.id_evento || e.id_evento === entrada.opciones.id_evento;
            }
            return [entrada.id_venta, entrada.id_receta].includes(e.id_entidad);
          })
          .map((e) => campos(e, ['id_evento', 'estado', 'intentos']));
        const cliente = (c) =>
          campos(c, [
            'id_cliente',
            'version',
            'activo',
            'email',
            'telefono',
            'obra_social',
            'nro_afiliado',
          ]);
        if (entrada.accion) {
          return {
            mongo: {
              cliente: cliente(mongo.clientes.find((c) => c.id_cliente === entrada.id_cliente)),
              eventos,
            },
          };
        }
        if (entrada.operacion) {
          return {
            mongo: { eventos },
            grafo: grafo.map((fila) => ({ ...fila, cliente: cliente(fila.cliente) })),
          };
        }
        return {
          mongo: {
            receta: campos(mongo.receta, [
              'id_receta',
              'version',
              'dispensas_realizadas',
              'proxima_dispensa',
              'estado',
            ]),
            venta: campos(mongo.venta, ['id_venta', 'total', 'estado', 'stock_aplicado']),
            lotes: mongo.lotes.map((l) => campos(l, ['id_lote', 'unidades'])),
            eventos,
          },
        };
      }),
      historial_final: {
        cliente: campos(despuesBaja.cliente, ['id_cliente', 'activo', 'version']),
        movimientos: despuesBaja.historial.map((e) => ({
          id: e.id_venta ?? e.id_receta,
          fecha: e.fecha,
          estado: e.estado,
        })),
      },
      outbox_final: final,
      verificaciones: {
        fefo_dos_lotes: true,
        stock_no_descontado_por_sincronizacion: true,
        rechazos_sin_cambios: true,
        historial_conservado_tras_baja: true,
        version_vieja_no_revierte: true,
        recuperacion_sin_duplicados: true,
        pendientes_finales_cero: true,
      },
    };
  }),
);
