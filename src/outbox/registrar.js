import { AppError } from '../shared/errors.js';

// Mismos tipos e identificadores que consume aplicarEvento en el grafo.
const identificadores = new Map([
  ['cliente', 'id_cliente'],
  ['receta', 'id_receta'],
  ['venta', 'id_venta'],
  ['farmaceutico', 'id_farmaceutico'],
  ['sucursal', 'id_sucursal'],
]);

function validarEvento(evento) {
  const campoId = identificadores.get(evento?.tipo_entidad);
  const problemas = [];
  if (!campoId) {
    problemas.push('tipo_entidad no soportado');
  }
  if (typeof evento?.id_entidad !== 'string' || evento.id_entidad.trim() === '') {
    problemas.push('id_entidad debe ser un string no vacío');
  }
  if (!Number.isSafeInteger(evento?.version) || evento.version < 1) {
    problemas.push('version debe ser un entero positivo seguro');
  }
  const contenido = evento?.contenido;
  if (contenido === null || typeof contenido !== 'object' || Array.isArray(contenido)) {
    problemas.push('contenido debe ser un objeto');
  } else {
    if (campoId && contenido[campoId] !== evento.id_entidad) {
      problemas.push(`contenido.${campoId} no coincide con id_entidad`);
    }
    if (contenido.version !== evento.version) {
      problemas.push('contenido.version no coincide con version');
    }
  }
  if (problemas.length) {
    throw new AppError('EVENTO_INVALIDO', `Evento inconsistente: ${problemas.join('; ')}`);
  }
}

/**
 * Inserta un evento pendiente usando la misma sesión que modifica la entidad.
 * Los errores se propagan para abortar la transacción; los duplicados se rechazan.
 * La sincronización con Neo4j se ejecuta después del commit.
 *
 * @param {import('mongodb').Db} db
 * @param {import('mongodb').ClientSession} session
 * @param {{tipo_entidad: string, id_entidad: string, version: number, contenido: object}} evento
 *   `contenido` es la instantánea completa de la entidad ya validada por el servicio;
 *   se comprueba su ID y versión y se descarta su `_id` sin modificar el objeto original.
 * @returns {Promise<void>}
 * @throws {AppError} `TRANSACCION_REQUERIDA` o `EVENTO_INVALIDO`.
 *   Los errores de persistencia, incluidos duplicados, se propagan sin ocultarlos.
 */
export async function registrarEvento(db, session, evento) {
  if (!session?.inTransaction()) {
    throw new AppError('TRANSACCION_REQUERIDA', 'La outbox requiere una transacción activa');
  }
  validarEvento(evento);
  const { _id, ...contenido } = evento.contenido;
  await db.collection('outbox').insertOne(
    {
      id_evento: `${evento.tipo_entidad}:${evento.id_entidad}:${evento.version}`,
      tipo_entidad: evento.tipo_entidad,
      id_entidad: evento.id_entidad,
      version: evento.version,
      contenido,
      estado: 'Pendiente',
      intentos: 0,
      creado_en: new Date(),
      ultimo_error: null,
      procesado_en: null,
    },
    { session },
  );
}
