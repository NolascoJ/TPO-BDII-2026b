const nullableString = { bsonType: ['string', 'null'] };
const integer = (minimum = 0) => ({
  bsonType: ['int', 'long', 'double'],
  minimum,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
});
const date = { bsonType: 'date' };
const choice = (...values) => ({ enum: values });
const common = { version: integer(1) };

// Usamos estas definiciones tanto para leer los CSV como para validar los datos en MongoDB
export const definitions = {
  clientes: {
    id: 'id_cliente',
    properties: {
      id_cliente: { bsonType: 'string', minLength: 1 },
      nombre: { bsonType: 'string', minLength: 1 },
      apellido: { bsonType: 'string', minLength: 1 },
      dni: { bsonType: 'string', minLength: 1 },
      ciudad: { bsonType: 'string', minLength: 1 },
      provincia: { bsonType: 'string', minLength: 1 },
      email: { bsonType: ['string', 'null'] },
      telefono: { bsonType: ['string', 'null'] },
      nro_afiliado: { bsonType: ['string', 'null'] },
      obra_social: choice('OSDE', 'Swiss Medical', 'PAMI', 'IOMA', 'Galeno', 'Sin cobertura'),
      activo: { bsonType: 'bool' },
    },
  },
  sucursales: {
    id: 'id_sucursal',
    properties: {
      id_sucursal: { bsonType: 'string', minLength: 1 },
      nombre: { bsonType: 'string', minLength: 1 },
      direccion: { bsonType: 'string', minLength: 1 },
      ciudad: { bsonType: 'string', minLength: 1 },
      provincia: { bsonType: 'string', minLength: 1 },
      telefono: nullableString,
      tipo: choice('Farmacia', 'Droguería'),
      activo: { bsonType: 'bool' },
    },
  },
  farmaceuticos: {
    id: 'id_farmaceutico',
    properties: {
      id_farmaceutico: { bsonType: 'string', minLength: 1 },
      nombre: { bsonType: 'string', minLength: 1 },
      apellido: { bsonType: 'string', minLength: 1 },
      matricula: { bsonType: 'string', minLength: 1 },
      id_sucursal: { bsonType: 'string', minLength: 1 },
      cargo: choice('Director Técnico', 'Farmacéutico'),
      activo: { bsonType: 'bool' },
    },
  },
  proveedores: {
    id: 'id_proveedor',
    properties: {
      id_proveedor: { bsonType: 'string', minLength: 1 },
      razon_social: { bsonType: 'string', minLength: 1 },
      cuit: { bsonType: 'string', minLength: 1 },
      ciudad: { bsonType: 'string', minLength: 1 },
      provincia: { bsonType: 'string', minLength: 1 },
      telefono: nullableString,
      tipo: choice('Laboratorio', 'Droguería'),
      activo: { bsonType: 'bool' },
    },
  },
  productos: {
    id: 'id_producto',
    properties: {
      id_producto: { bsonType: 'string', minLength: 1 },
      nombre: { bsonType: 'string', minLength: 1 },
      principio_activo: { bsonType: 'string', minLength: 1 },
      categoria: { bsonType: 'string', minLength: 1 },
      presentacion: { bsonType: 'string', minLength: 1 },
      id_proveedor: { bsonType: 'string', minLength: 1 },
      condicion_venta: choice('Venta libre', 'Bajo receta', 'Bajo receta archivada'),
      precio_unit: integer(),
      activo: { bsonType: 'bool' },
    },
  },
  stock_lotes: {
    id: 'id_lote',
    properties: {
      id_lote: { bsonType: 'string', minLength: 1 },
      id_producto: { bsonType: 'string', minLength: 1 },
      id_sucursal: { bsonType: 'string', minLength: 1 },
      nro_lote: { bsonType: 'string', minLength: 1 },
      unidades: integer(),
      vencimiento: date,
    },
  },
  recetas: {
    id: 'id_receta',
    properties: {
      id_receta: { bsonType: 'string', minLength: 1 },
      id_cliente: { bsonType: 'string', minLength: 1 },
      medico: { bsonType: 'string', minLength: 1 },
      matricula_medico: { bsonType: 'string', minLength: 1 },
      fecha_emision: date,
      tipo: choice('Simple', 'Archivada', 'Tratamiento prolongado'),
      dispensas_autorizadas: { ...integer(1), maximum: 3 },
      dispensas_realizadas: integer(),
      proxima_dispensa: { bsonType: ['date', 'null'] },
      estado: choice('Vigente', 'Completada', 'Vencida'),
    },
  },
  ventas: {
    id: 'id_venta',
    properties: {
      id_venta: { bsonType: 'string', minLength: 1 },
      id_cliente: { bsonType: 'string', minLength: 1 },
      id_farmaceutico: { bsonType: 'string', minLength: 1 },
      id_sucursal: { bsonType: 'string', minLength: 1 },
      id_receta: nullableString,
      fecha: date,
      tipo: choice('Venta libre', 'Con receta'),
      medio_pago: choice('Efectivo', 'Débito', 'Crédito', 'Transferencia', 'Obra social'),
      total: integer(),
      estado: choice('Completada', 'Pendiente', 'Anulada'),
      stock_aplicado: { bsonType: 'bool' },
      origen: choice('importacion', 'operacion'),
      items: {
        bsonType: 'array',
        minItems: 1,
        items: {
          bsonType: 'object',
          required: ['id_detalle', 'id_producto', 'cantidad', 'precio_unit'],
          properties: {
            id_detalle: { bsonType: 'string', minLength: 1 },
            id_producto: { bsonType: 'string', minLength: 1 },
            cantidad: integer(1),
            precio_unit: integer(),
          },
        },
      },
    },
  },
};
export const detailDefinition = {
  id: 'id_detalle',
  properties: {
    id_detalle: { bsonType: 'string', minLength: 1 },
    id_venta: { bsonType: 'string', minLength: 1 },
    id_producto: { bsonType: 'string', minLength: 1 },
    cantidad: integer(1),
    precio_unit: integer(),
  },
};

const indexes = {
  clientes: [{ key: { dni: 1 }, unique: true }],
  farmaceuticos: [{ key: { matricula: 1 }, unique: true }, { key: { id_sucursal: 1 } }],
  productos: [{ key: { activo: 1 } }],
  stock_lotes: [
    { key: { id_sucursal: 1, id_producto: 1, vencimiento: 1, id_lote: 1 } },
    { key: { unidades: 1 } },
  ],
  recetas: [{ key: { id_cliente: 1 } }, { key: { tipo: 1, estado: 1, proxima_dispensa: 1 } }],
  ventas: [
    { key: { estado: 1 } },
    { key: { id_cliente: 1, fecha: 1 } },
    { key: { id_farmaceutico: 1, fecha: 1 } },
    { key: { fecha: 1, estado: 1 } },
    { key: { 'items.id_detalle': 1 }, unique: true },
  ],
};

// Preparamos los validadores y los índices. Si ya existen, los actualizamos sin borrar datos
export async function ensureSchema(db) {
  const schemas = Object.fromEntries(
    Object.entries(definitions).map(([name, def]) => [
      name,
      {
        bsonType: 'object',
        required: [...Object.keys(def.properties), 'version'],
        properties: { ...common, ...def.properties },
      },
    ]),
  );
  schemas.outbox = {
    bsonType: 'object',
    required: [
      'id_evento',
      'tipo_entidad',
      'id_entidad',
      'version',
      'contenido',
      'estado',
      'intentos',
      'creado_en',
      'ultimo_error',
      'procesado_en',
    ],
    properties: {
      id_evento: { bsonType: 'string', minLength: 1 },
      id_entidad: { bsonType: 'string', minLength: 1 },
      tipo_entidad: choice('cliente', 'receta', 'venta', 'farmaceutico', 'sucursal'),
      version: integer(1),
      contenido: { bsonType: 'object' },
      estado: choice('Pendiente', 'Procesado'),
      intentos: integer(),
      creado_en: date,
      ultimo_error: nullableString,
      procesado_en: { bsonType: ['date', 'null'] },
    },
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const validator = { $jsonSchema: schema };
    try {
      await db.createCollection(name, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } catch (error) {
      if (error.code !== 48) {
        throw error;
      }
      await db.command({
        collMod: name,
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }
    if (definitions[name]) {
      await db.collection(name).createIndex({ [definitions[name].id]: 1 }, { unique: true });
    }
    for (const { key, ...options } of indexes[name] ?? []) {
      await db.collection(name).createIndex(key, options);
    }
  }
  await db.collection('outbox').createIndex({ id_evento: 1 }, { unique: true });
  await db.collection('outbox').createIndex({ estado: 1, creado_en: 1 });
  await db
    .collection('outbox')
    .createIndex({ tipo_entidad: 1, id_entidad: 1, version: 1 }, { unique: true });
}
