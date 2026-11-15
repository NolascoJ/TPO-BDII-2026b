import { AppError } from '../shared/errors.js';
import {
  proyectarClientes,
  proyectarFarmaceuticos,
  proyectarRecetas,
  proyectarSucursales,
  proyectarVentas,
} from './proyeccion.js';

// Tipos de evento que admite la outbox (ver el validador en src/db/schema.js)
const TIPOS = {
  cliente: { id: 'id_cliente', proyectar: proyectarClientes },
  receta: { id: 'id_receta', proyectar: proyectarRecetas },
  venta: { id: 'id_venta', proyectar: proyectarVentas },
  farmaceutico: { id: 'id_farmaceutico', proyectar: proyectarFarmaceuticos },
  sucursal: { id: 'id_sucursal', proyectar: proyectarSucursales },
};

function validarEvento(evento) {
  const tipo = TIPOS[evento?.tipo_entidad];
  if (!tipo) {
    throw new AppError('EVENTO_INVALIDO', `Tipo de entidad no soportado: ${evento?.tipo_entidad}`, {
      id_evento: evento?.id_evento ?? null,
      reintentable: false,
    });
  }
  const { contenido } = evento;
  const problemas = [];
  if (contenido === null || typeof contenido !== 'object') {
    problemas.push('contenido ausente');
  } else {
    if (contenido[tipo.id] !== evento.id_entidad) {
      problemas.push(`contenido.${tipo.id} no coincide con id_entidad`);
    }
    if (contenido.version !== evento.version) {
      problemas.push('contenido.version no coincide con version');
    }
  }
  if (problemas.length > 0) {
    throw new AppError('EVENTO_INVALIDO', `Evento inconsistente: ${problemas.join('; ')}`, {
      id_evento: evento.id_evento ?? null,
      reintentable: false,
    });
  }
  return tipo;
}

/**
 * Aplica un evento de la outbox en Neo4j, en una transacción propia del grafo.
 *
 * Lo llama el procesador de pendientes (integrante 4) con el documento de `outbox` tal como
 * está en MongoDB. No lee ni modifica MongoDB: marcar el evento es tarea del procesador,
 * **después** de que esta función termine sin error.
 *
 * Es idempotente y respeta versiones: si el nodo ya tiene esa versión o una mayor, no cambia
 * nada y devuelve `obsoleto`. Por eso repetir un evento (por ejemplo, si el procesador se cayó
 * después de confirmar en Neo4j y antes de marcarlo) es seguro.
 *
 * Errores (el evento debe quedar `Pendiente`, con `intentos` + 1 y `ultimo_error`):
 * - `DEPENDENCIA_FALTANTE` (`details.reintentable: true`): falta en el grafo un nodo que el
 *   evento referencia (por ejemplo, el cliente de una venta). No se escribe nada.
 * - `EVENTO_INVALIDO` (`details.reintentable: false`): tipo desconocido o contenido que no
 *   coincide con `id_entidad`/`version`. Reintentarlo no lo va a arreglar.
 * - Errores del driver de Neo4j (servicio caído, conflictos transitorios): reintentables.
 *
 * @param {import('neo4j-driver').Driver} driver
 * @param {string} database Base de Neo4j (`config().neo4jDatabase`).
 * @param {{id_evento: string, tipo_entidad: string, id_entidad: string, version: number, contenido: object}} evento
 * @returns {Promise<{estado: 'aplicado' | 'obsoleto'}>} Ambos estados se marcan `Procesado`.
 */
export async function aplicarEvento(driver, database, evento) {
  const { proyectar } = validarEvento(evento);
  const session = driver.session({ database });
  try {
    const [resultado] = await session.executeWrite((tx) => proyectar(tx, [evento.contenido]));
    return { estado: resultado.aplicado ? 'aplicado' : 'obsoleto' };
  } finally {
    await session.close();
  }
}
