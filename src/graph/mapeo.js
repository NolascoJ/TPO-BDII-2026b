import neo4j from 'neo4j-driver';

// Funciones puras: convierten un documento de MongoDB (o el `contenido` de un evento, que es
// la misma instantánea sin `_id`) en los parámetros que usan las sentencias Cypher.
// Cada entidad lista explícitamente sus propiedades: así no se filtran al grafo campos técnicos
// de MongoDB (`_id`, `stock_aplicado`) ni arreglos de objetos (`items`).

/**
 * Convierte un `Date` en un `DateTime` de Neo4j en UTC (offset 0), independiente de la zona
 * horaria del host. `null` se conserva.
 * @param {Date | null | undefined} date
 */
export function aDateTime(date) {
  if (date === null || date === undefined) {
    return null;
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`Fecha inválida: ${date}`);
  }
  return new neo4j.types.DateTime(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds() * 1_000_000,
    0,
  );
}

// El driver envía los números de JavaScript como Float; los enteros se envían como Integer
const entero = (value) => neo4j.int(value);

const elegir = (doc, campos) =>
  Object.fromEntries(campos.map((campo) => [campo, doc[campo] ?? null]));

export function mapCliente(doc) {
  return {
    props: {
      ...elegir(doc, [
        'id_cliente',
        'nombre',
        'apellido',
        'dni',
        'email',
        'telefono',
        'ciudad',
        'provincia',
        'obra_social',
        'nro_afiliado',
        'activo',
      ]),
      version: entero(doc.version),
    },
  };
}

export function mapSucursal(doc) {
  return {
    props: {
      ...elegir(doc, [
        'id_sucursal',
        'nombre',
        'tipo',
        'direccion',
        'ciudad',
        'provincia',
        'telefono',
        'activo',
      ]),
      version: entero(doc.version),
    },
  };
}

export function mapProducto(doc) {
  return {
    props: {
      ...elegir(doc, [
        'id_producto',
        'nombre',
        'principio_activo',
        'categoria',
        'presentacion',
        'condicion_venta',
        'activo',
      ]),
      version: entero(doc.version),
    },
  };
}

export function mapFarmaceutico(doc) {
  return {
    props: {
      ...elegir(doc, ['id_farmaceutico', 'nombre', 'apellido', 'matricula', 'cargo', 'activo']),
      version: entero(doc.version),
    },
    id_sucursal: doc.id_sucursal,
  };
}

export function mapReceta(doc) {
  return {
    props: {
      ...elegir(doc, ['id_receta', 'medico', 'matricula_medico', 'tipo', 'estado']),
      fecha_emision: aDateTime(doc.fecha_emision),
      proxima_dispensa: aDateTime(doc.proxima_dispensa),
      dispensas_autorizadas: entero(doc.dispensas_autorizadas),
      dispensas_realizadas: entero(doc.dispensas_realizadas),
      version: entero(doc.version),
    },
    id_cliente: doc.id_cliente,
  };
}

export function mapVenta(doc) {
  return {
    props: {
      ...elegir(doc, ['id_venta', 'tipo', 'medio_pago', 'estado', 'origen']),
      fecha: aDateTime(doc.fecha),
      total: entero(doc.total),
      version: entero(doc.version),
    },
    id_cliente: doc.id_cliente,
    id_farmaceutico: doc.id_farmaceutico,
    id_sucursal: doc.id_sucursal,
    id_receta: doc.id_receta ?? null,
    // Los ítems no se guardan como propiedad: se proyectan como relaciones INCLUYE
    items: doc.items.map((item) => ({
      id_detalle: item.id_detalle,
      id_producto: item.id_producto,
      cantidad: entero(item.cantidad),
      precio_unit: entero(item.precio_unit),
    })),
  };
}
