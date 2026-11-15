import { aplicarEvento } from '../graph/eventos.js';
import { AppError } from '../shared/errors.js';

export function validarOpciones(opciones = {}) {
  if (opciones === null || typeof opciones !== 'object' || Array.isArray(opciones)) {
    throw new AppError('PARAMETROS_INVALIDOS', 'Se esperaba un objeto de opciones');
  }
  if (Object.keys(opciones).some((campo) => !['limite', 'id_evento'].includes(campo))) {
    throw new AppError('PARAMETROS_INVALIDOS', 'Solo se admiten limite e id_evento');
  }
  const limite = opciones.limite === undefined ? 100 : opciones.limite;
  if (!Number.isSafeInteger(limite) || limite < 1 || limite > 1000) {
    throw new AppError('PARAMETROS_INVALIDOS', 'limite debe ser un entero entre 1 y 1000');
  }
  if (
    Object.hasOwn(opciones, 'id_evento') &&
    (typeof opciones.id_evento !== 'string' || opciones.id_evento.trim() === '')
  ) {
    throw new AppError('PARAMETROS_INVALIDOS', 'id_evento debe ser un string no vacío');
  }
  return {
    limite,
    filtro: opciones.id_evento === undefined ? {} : { id_evento: opciones.id_evento },
  };
}

const mensajeError = (error) =>
  `${error?.code ?? 'ERROR'}: ${error?.message ?? String(error)}`.slice(0, 2000);

// Los fallos repetidos no deben ocupar siempre el comienzo de un lote pequeño.
const ordenPendientes = { intentos: 1, creado_en: 1, id_evento: 1 };

/**
 * Procesa un lote ordenado por intentos, creado_en e id_evento. Requiere una sola instancia.
 * Cada evento se intenta una vez por invocación; los fallidos quedan pendientes.
 * Los errores no reintentables requieren corregir el evento antes de repetir el comando.
 * intentos cuenta ejecuciones iniciadas, no reintentos internos del driver.
 *
 * Marca Procesado al recibir aplicado u obsoleto de Neo4j. Si falla una escritura en MongoDB,
 * detiene el lote y propaga el error. La guardia de versión permite repetir el evento
 * cuando Neo4j confirmó el cambio pero MongoDB no registró la marca.
 *
 * @param {{db: import('mongodb').Db, driver: import('neo4j-driver').Driver, neo4jDatabase: string}} context
 * @param {{limite?: number, id_evento?: string}} opciones
 * @param {{aplicar?: typeof aplicarEvento}} dependencias Sustitución para pruebas de fallas.
 * @returns {Promise<object>} Contadores y resultado de cada evento, sin su contenido.
 */
export async function procesarOutbox(
  { db, driver, neo4jDatabase },
  opciones = {},
  { aplicar = aplicarEvento } = {},
) {
  const { limite, filtro } = validarOpciones(opciones);
  const outbox = db.collection('outbox');
  const eventos = await outbox
    .find({ ...filtro, estado: 'Pendiente' })
    .sort(ordenPendientes)
    .limit(limite)
    .toArray();
  const resumen = {
    seleccionados: eventos.length,
    intentados: 0,
    procesados: 0,
    fallidos: 0,
    omitidos: 0,
    resultados: [],
  };
  for (const evento of eventos) {
    const pendiente = { _id: evento._id, estado: 'Pendiente' };
    const inicio = await outbox.updateOne(pendiente, { $inc: { intentos: 1 } });
    if (!inicio.matchedCount) {
      resumen.omitidos += 1;
      resumen.resultados.push({ id_evento: evento.id_evento, estado: 'omitido' });
      continue;
    }
    resumen.intentados += 1;
    let resultado;
    try {
      resultado = await aplicar(driver, neo4jDatabase, evento);
      if (!['aplicado', 'obsoleto'].includes(resultado?.estado)) {
        throw new AppError('RESULTADO_INVALIDO', 'El aplicador no confirmó el evento', {
          reintentable: false,
        });
      }
    } catch (error) {
      const mensaje = mensajeError(error);
      await outbox.updateOne(pendiente, { $set: { ultimo_error: mensaje, procesado_en: null } });
      resumen.fallidos += 1;
      resumen.resultados.push({
        id_evento: evento.id_evento,
        estado: 'fallido',
        error: mensaje,
        reintentable: error?.details?.reintentable !== false,
      });
      continue;
    }
    // Fuera del catch del aplicador: un fallo de MongoDB no debe confundirse con uno del grafo.
    const marca = await outbox.updateOne(pendiente, {
      $set: { estado: 'Procesado', procesado_en: new Date(), ultimo_error: null },
    });
    if (marca.matchedCount) {
      resumen.procesados += 1;
      resumen.resultados.push({ id_evento: evento.id_evento, estado: resultado.estado });
    } else {
      resumen.omitidos += 1;
      resumen.resultados.push({ id_evento: evento.id_evento, estado: 'omitido' });
    }
  }
  resumen.pendientes = await outbox.countDocuments({ estado: 'Pendiente' });
  return resumen;
}

/** Estado de la outbox en MongoDB, sin requerir Neo4j. El detalle solo incluye pendientes. */
export async function consultarOutbox({ db }, opciones = {}) {
  const { limite, filtro } = validarOpciones(opciones);
  const outbox = db.collection('outbox');
  const [pendientes, procesados, conError, eventos] = await Promise.all([
    outbox.countDocuments({ ...filtro, estado: 'Pendiente' }),
    outbox.countDocuments({ ...filtro, estado: 'Procesado' }),
    outbox.countDocuments({ ...filtro, estado: 'Pendiente', ultimo_error: { $ne: null } }),
    outbox
      .find({ ...filtro, estado: 'Pendiente' }, { projection: { _id: 0, contenido: 0 } })
      .sort(ordenPendientes)
      .limit(limite)
      .toArray(),
  ]);
  return { pendientes, procesados, con_error: conError, eventos_pendientes: eventos };
}
