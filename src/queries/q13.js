import { AppError } from '../shared/errors.js';
import { registrarEvento } from '../outbox/registrar.js';
import { validarSolicitud, aplicarDatos } from '../services/cliente/datos.js';

const sinId = { projection: { _id: 0 } };

async function cambiarCliente(db, session, pedido) {
  const clientes = db.collection('clientes');
  let cliente;
  if (pedido.accion === 'alta') {
    cliente = {
      ...aplicarDatos({}, pedido.datos),
      id_cliente: pedido.id_cliente,
      activo: true,
      version: 1,
    };
    // El índice único de DNI protege también frente a altas concurrentes y bajas previas.
    await clientes.insertOne({ ...cliente }, { session });
  } else {
    const actual = await clientes.findOne({ id_cliente: pedido.id_cliente }, { session, ...sinId });
    if (!actual) {
      throw new AppError('CLIENTE_INVALIDO', `Cliente inexistente: ${pedido.id_cliente}`, {
        id_cliente: pedido.id_cliente,
      });
    }
    const siguiente =
      pedido.accion === 'baja' ? { ...actual, activo: false } : aplicarDatos(actual, pedido.datos);
    const cambios = Object.fromEntries(
      Object.entries(siguiente).filter(([campo, valor]) => valor !== actual[campo]),
    );
    if (Object.keys(cambios).length === 0) {
      return { cliente: actual, modificado: false };
    }
    cliente = await clientes.findOneAndUpdate(
      { id_cliente: pedido.id_cliente },
      { $set: cambios, $inc: { version: 1 } },
      { session, returnDocument: 'after', ...sinId },
    );
  }
  await registrarEvento(db, session, {
    tipo_entidad: 'cliente',
    id_entidad: cliente.id_cliente,
    version: cliente.version,
    contenido: cliente,
  });
  return { cliente, modificado: true };
}

/**
 * q13: ABM de clientes en MongoDB; cada cambio y su evento se confirman juntos.
 *
 * Alta: {accion:'alta', id_cliente, datos:{nombre, apellido, dni, ciudad, provincia,
 *   email?, telefono?, obra_social?, nro_afiliado?}}. Activo=true y version=1 son del sistema.
 * Modificación: {accion:'modificar', id_cliente, datos:{email?, telefono?, ciudad?, provincia?,
 *   obra_social?, nro_afiliado?}}; debe incluir al menos un campo. Permite corregir datos de
 *   clientes inactivos sin reactivarlos. DNI, nombre e identificadores son inmutables aquí.
 * Baja: {accion:'baja', id_cliente}; conserva cliente, DNI e historial, con activo=false.
 *
 * Cada cambio efectivo incrementa version y genera una instantánea completa en outbox.
 * Repetir una baja o una modificación que ya coincide no escribe ni genera eventos.
 * El alta repetida se rechaza por ID/DNI duplicado. La sesión y los reintentos de conflictos
 * transitorios los maneja este servicio; no sincroniza Neo4j durante la transacción.
 *
 * @param {{client: import('mongodb').MongoClient, db: import('mongodb').Db}} context
 * @param {{accion: 'alta'|'modificar'|'baja', id_cliente: string, datos?: object}} params
 * @returns {Promise<{cliente: object, modificado: boolean}>} Cliente final sin `_id`.
 * @throws {AppError} `PARAMETROS_INVALIDOS`, `CLIENTE_INVALIDO`, `DNI_DUPLICADO`,
 *   `ID_CLIENTE_DUPLICADO`; los errores de persistencia/outbox también abortan y se propagan.
 */
export async function q13({ client, db }, params = {}) {
  const pedido = validarSolicitud(params);
  const session = client.startSession();
  try {
    return await session.withTransaction(() => cambiarCliente(db, session, pedido), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.dni === 1) {
      throw new AppError(
        'DNI_DUPLICADO',
        'Ya existe un cliente con ese DNI, incluso si está inactivo',
      );
    }
    if (error.code === 11000 && error.keyPattern?.id_cliente === 1) {
      throw new AppError('ID_CLIENTE_DUPLICADO', `Ya existe el cliente ${pedido.id_cliente}`, {
        id_cliente: pedido.id_cliente,
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }
}
