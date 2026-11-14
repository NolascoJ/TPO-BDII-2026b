/**
 * Registra un evento pendiente de sincronización en `outbox`, dentro de la transacción
 * recibida. No confirma por su cuenta: el evento se persiste solo si la transacción
 * de negocio se confirma.
 *
 * Adaptador provisorio: se reemplaza por la utilidad común de outbox cuando esté
 * disponible, manteniendo esta firma.
 *
 * @param {import('mongodb').Db} db
 * @param {import('mongodb').ClientSession} session
 * @param {{tipo_entidad: string, id_entidad: string, version: number, contenido: object}} evento
 *   `contenido` es la instantánea completa de la entidad; se descarta su `_id`.
 */
export async function registrarEvento(db, session, evento) {
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
