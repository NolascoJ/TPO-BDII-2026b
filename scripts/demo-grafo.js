import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { connectMongo, connectNeo4j } from '../src/db/connections.js';
import { ensureSchema } from '../src/db/schema.js';
import { loadData } from '../src/data/load.js';
import { cargarGrafo, vaciarGrafo } from '../src/graph/bootstrap.js';
import { aplicarEvento } from '../src/graph/eventos.js';
import { registros } from '../src/graph/valores.js';
import { q03 } from '../src/queries/q03.js';
import { q04 } from '../src/queries/q04.js';
import { q05 } from '../src/queries/q05.js';
import { q10 } from '../src/queries/q10.js';
import { q12 } from '../src/queries/q12.js';
import { q14 } from '../src/queries/q14.js';
import { errorResult } from '../src/shared/errors.js';

// Evidencia de la proyección en Neo4j: carga inicial, consultas del grafo y aplicación de
// eventos. Usa una base temporal de MongoDB cargada con los CSV. Neo4j Community tiene una sola
// base: el script vacía el grafo y, al terminar, lo reconstruye desde la base de trabajo.

const trabajo = config();
const settings = {
  ...trabajo,
  mongoDatabase: `farmared_demo_${randomUUID().replaceAll('-', '')}`,
};
const database = settings.neo4jDatabase;
const { client, db } = await connectMongo(settings);
const driver = await connectNeo4j(settings);
const ctx = { driver, neo4jDatabase: database };
const sinId = { projection: { _id: 0 } };

async function intentar(operacion) {
  try {
    return { ok: true, data: await operacion() };
  } catch (error) {
    return errorResult(error);
  }
}

async function conteos() {
  const [fila] = registros(
    await driver.executeQuery(
      `RETURN
         COUNT { (:Sucursal) } AS sucursales, COUNT { (:Producto) } AS productos,
         COUNT { (:Cliente) } AS clientes, COUNT { (:Farmaceutico) } AS farmaceuticos,
         COUNT { (:Receta) } AS recetas, COUNT { (:Venta) } AS ventas,
         COUNT { ()-[:TRABAJA_EN]->() } AS trabaja_en,
         COUNT { ()-[:TIENE_RECETA]->() } AS tiene_receta,
         COUNT { ()-[:REALIZO]->() } AS realizo,
         COUNT { ()-[:ATENDIDA_POR]->() } AS atendida_por,
         COUNT { ()-[:REGISTRADA_EN]->() } AS registrada_en,
         COUNT { ()-[:USA_RECETA]->() } AS usa_receta,
         COUNT { ()-[:INCLUYE]->() } AS incluye`,
      {},
      { database },
    ),
  );
  return fila;
}

// Resumen legible del historial: fecha (día), tipo de evento, ID y estado
const resumenHistorial = ({ historial }) =>
  historial.map((e) => ({
    fecha: e.fecha.toISOString().slice(0, 10),
    evento: e.evento,
    id: e.id_venta ?? e.id_receta,
    estado: e.estado,
    ...(e.evento === 'receta'
      ? { dispensas: `${e.dispensas_realizadas}/${e.dispensas_autorizadas}` }
      : {}),
  }));

const evento = (tipo_entidad, idCampo, contenido) => ({
  id_evento: `${tipo_entidad}:${contenido[idCampo]}:${contenido.version}`,
  tipo_entidad,
  id_entidad: contenido[idCampo],
  version: contenido.version,
  contenido,
});

const salida = { fecha_sistema: new Date() };
try {
  await ensureSchema(db);
  await loadData(client, db);

  // Carga inicial: dos ejecuciones seguidas
  const primera = await cargarGrafo({ db, ...ctx }, { reset: true });
  const segunda = await cargarGrafo({ db, ...ctx });
  salida.carga_inicial = {
    primera: primera.entidades,
    segunda: segunda.entidades,
    grafo: await conteos(),
  };

  salida.consultas = {
    q03_C006: await q03(ctx, { id_cliente: 'C006' }),
    q03_C008: await q03(ctx, { id_cliente: 'C008' }),
    q03_inexistente: await intentar(() => q03(ctx, { id_cliente: 'C999' })),
    q04: await q04(ctx),
    q05: await q05(ctx),
    q10_S002: await q10(ctx, { id_sucursal: 'S002' }),
    q10_S005: await q10(ctx, { id_sucursal: 'S005' }),
    q12: await q12(ctx),
  };

  // Eventos: una venta real con q14 y sus eventos de la outbox
  const recetaV1 = await db.collection('recetas').findOne({ id_receta: 'RC004' }, sinId);
  const historialAntes = resumenHistorial(await q03(ctx, { id_cliente: 'C006' }));
  const venta = await intentar(() =>
    q14(
      { client, db },
      {
        id_venta: 'V-DEMO-G1',
        id_cliente: 'C006',
        id_farmaceutico: 'F001',
        id_receta: 'RC004',
        medio_pago: 'Obra social',
        items: [{ id_producto: 'PRD003', cantidad: 1 }],
      },
    ),
  );
  const pendientes = await db
    .collection('outbox')
    .find({ estado: 'Pendiente' })
    .sort({ creado_en: 1, id_evento: 1 })
    .toArray();
  const aplicar = (e) => intentar(() => aplicarEvento(driver, database, e));

  const primeraAplicacion = [];
  for (const e of pendientes) {
    primeraAplicacion.push({ id_evento: e.id_evento, resultado: await aplicar(e) });
  }
  const historialDespues = resumenHistorial(await q03(ctx, { id_cliente: 'C006' }));
  const grafoAntesDeRepetir = await conteos();
  const repeticion = [];
  for (const e of pendientes) {
    repeticion.push({ id_evento: e.id_evento, resultado: await aplicar(e) });
  }

  // Dependencia faltante: una venta de un cliente que el grafo todavía no tiene
  const contenidoVenta = pendientes.find((e) => e.tipo_entidad === 'venta').contenido;
  const huerfana = evento('venta', 'id_venta', {
    ...contenidoVenta,
    id_venta: 'V-DEMO-G2',
    id_cliente: 'C-DEMO',
    id_receta: null,
    tipo: 'Venta libre',
    items: [{ ...contenidoVenta.items[0], id_detalle: 'V-DEMO-G2-01' }],
  });
  const base = await db.collection('clientes').findOne({ id_cliente: 'C005' }, sinId);
  const clienteNuevo = evento('cliente', 'id_cliente', {
    ...base,
    id_cliente: 'C-DEMO',
    dni: '99999999',
    version: 1,
  });

  // Historia de q10: F003 pasa a S001; sus ventas en S002 no se mueven
  const f003 = await db.collection('farmaceuticos').findOne({ id_farmaceutico: 'F003' }, sinId);
  const clientesS002 = async () =>
    (await q10(ctx, { id_sucursal: 'S002' })).clientes.map((c) => c.id_cliente);
  const q10Antes = await clientesS002();
  const cambioSucursal = await aplicar(
    evento('farmaceutico', 'id_farmaceutico', { ...f003, id_sucursal: 'S001', version: 2 }),
  );

  salida.eventos = {
    venta_q14: venta.ok ? { ok: true, venta: venta.data.venta } : venta,
    historial_C006_antes: historialAntes,
    eventos_pendientes: pendientes.map(({ _id, contenido: _c, ...e }) => e),
    primera_aplicacion: primeraAplicacion,
    historial_C006_despues: historialDespues,
    repeticion,
    repeticion_sin_cambios: JSON.stringify(await conteos()) === JSON.stringify(grafoAntesDeRepetir),
    receta_vieja_v1: await aplicar(evento('receta', 'id_receta', recetaV1)),
    dependencia_faltante: {
      venta_sin_cliente: await aplicar(huerfana),
      llega_el_cliente: await aplicar(clienteNuevo),
      reintento_de_la_venta: await aplicar(huerfana),
    },
    evento_invalido: await aplicar({ ...pendientes[0], tipo_entidad: 'stock' }),
    cambio_de_sucursal: {
      q10_S002_antes: q10Antes,
      evento_F003_a_S001: cambioSucursal,
      q10_S002_despues: await clientesS002(),
    },
  };
} finally {
  await vaciarGrafo(driver, database);
  await db.dropDatabase();
  await client.close();
  // Reconstruye la proyección de trabajo desde la base de trabajo
  const conexion = await connectMongo(trabajo);
  try {
    const reconstruccion = await cargarGrafo({ db: conexion.db, ...ctx }, { reset: true });
    salida.proyeccion_de_trabajo_reconstruida = reconstruccion.entidades;
  } finally {
    await conexion.client.close();
    await driver.close();
  }
}

console.log(JSON.stringify(salida, null, 2));
