import { connectMongo, crearDriverNeo4j } from '../src/db/connections.js';
import { config } from '../src/config.js';
import { AppError, errorResult } from '../src/shared/errors.js';
import { procesarOutbox, consultarOutbox, validarOpciones } from '../src/outbox/procesar.js';

// Una ejecución procesa un lote; repetir el comando reintenta los pendientes.
// Usar una sola instancia del procesador a la vez y preparar el grafo con graph:load.
// npm run outbox:procesar -- '{"limite":100}'
// npm run outbox:procesar -- '{"id_evento":"cliente:C001:2"}'
// npm run outbox:estado -- '{"limite":20}'  (solo requiere MongoDB)
let client;
let driver;
try {
  const [accion, json = '{}', ...extra] = process.argv.slice(2);
  if (!['procesar', 'estado'].includes(accion) || extra.length) {
    throw new AppError('PARAMETROS_INVALIDOS', 'Uso: outbox.js <procesar|estado> [JSON]');
  }
  const opciones = JSON.parse(json);
  validarOpciones(opciones);
  const settings = config();
  const conexion = await connectMongo(settings);
  client = conexion.client;
  if (accion === 'procesar') {
    // Sin verificación anticipada: una caída del grafo debe quedar registrada por evento.
    // El siguiente comando será el reintento; se desactivan los reintentos internos largos.
    driver = crearDriverNeo4j(settings, {
      maxTransactionRetryTime: 0,
      connectionAcquisitionTimeout: 3000,
    });
  }
  const contexto = { db: conexion.db, driver, neo4jDatabase: settings.neo4jDatabase };
  const data =
    accion === 'procesar'
      ? await procesarOutbox(contexto, opciones)
      : await consultarOutbox(contexto, opciones);
  const ok = accion !== 'procesar' || data.fallidos === 0;
  console.log(JSON.stringify({ ok, accion, data }, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify(errorResult(error), null, 2));
  process.exitCode = 1;
} finally {
  try {
    await driver?.close();
  } finally {
    await client?.close();
  }
}
