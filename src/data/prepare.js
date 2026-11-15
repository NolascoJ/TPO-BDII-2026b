import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { definitions, detailDefinition } from '../db/schema.js';
import { AppError } from '../shared/errors.js';

const allDefinitions = { ...definitions, detalle_ventas: detailDefinition };
const derivedSaleFields = new Set(['items', 'id_sucursal', 'stock_aplicado', 'origen']);

function invalidData(message) {
  throw new AppError('DATOS_INVALIDOS', message);
}

// Convertimos los campos según el esquema. Los IDs y documentos quedan como strings
export function convertValue(value, rule, location) {
  if (value === '') {
    value = null;
  }

  const types = [].concat(rule.bsonType ?? []);

  if (value === null) {
    if (types.includes('null')) {
      return null;
    }
    invalidData(`${location}: nulo no permitido`);
  }

  if (rule.enum) {
    if (!rule.enum.includes(value)) {
      invalidData(`${location}: valor fuera del dominio`);
    }
    return value;
  }

  if (types.includes('bool')) {
    if (value === 'True' || value === true) {
      return true;
    }
    if (value === 'False' || value === false) {
      return false;
    }
    invalidData(`${location}: booleano inválido`);
  }

  if (types.includes('date')) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      invalidData(`${location}: fecha inválida`);
    }

    const date = new Date(`${value}T00:00:00.000Z`);
    // Date acomoda fechas como 30/02 por su cuenta, así que comparamos con el original para detectarlas
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      invalidData(`${location}: fecha inexistente`);
    }
    return date;
  }

  if (types.includes('int')) {
    if (typeof value === 'string' && !/^\d+$/.test(value)) {
      invalidData(`${location}: entero inválido`);
    }

    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < rule.minimum || number > rule.maximum) {
      invalidData(`${location}: entero fuera de rango`);
    }
    return number;
  }

  if (typeof value !== 'string' || (rule.minLength && value.length < rule.minLength)) {
    invalidData(`${location}: string inválido`);
  }
  return value;
}

export function convertRow(name, row) {
  const properties = Object.entries(allDefinitions[name].properties).filter(
    ([field]) => name !== 'ventas' || !derivedSaleFields.has(field),
  );
  const expectedFields = properties.map(([field]) => field);
  const receivedFields = Object.keys(row);
  const hasUnexpectedFields = receivedFields.some((field) => !expectedFields.includes(field));

  if (receivedFields.length !== expectedFields.length || hasUnexpectedFields) {
    invalidData(`${name}: encabezado o campos inesperados`);
  }

  return Object.fromEntries(
    properties.map(([field, rule]) => {
      if (!(field in row)) {
        invalidData(`${name}: falta ${field}`);
      }
      return [field, convertValue(row[field], rule, `${name}.${field}`)];
    }),
  );
}

export async function readProvided(directory = new URL('../../data/', import.meta.url)) {
  const entries = await Promise.all(
    Object.keys(allDefinitions).map(async (name) => {
      const contents = await readFile(new URL(`${name}.csv`, directory), 'utf8');
      const records = parse(contents, { columns: true, bom: true, skip_empty_lines: true });
      return [name, records.map((row) => convertRow(name, row))];
    }),
  );

  return Object.fromEntries(entries);
}

function indexRecords(provided) {
  const data = {};
  const recordsById = {};

  for (const [name, definition] of Object.entries(allDefinitions)) {
    data[name] = provided[name].map((row) => ({ ...row }));
    recordsById[name] = new Map();

    for (const row of data[name]) {
      const id = row[definition.id];
      if (recordsById[name].has(id)) {
        invalidData(`${name}: ID duplicado ${id}`);
      }
      recordsById[name].set(id, row);
    }
  }

  return { data, recordsById };
}

function validateUniqueField(rows, collection, field) {
  const values = rows.map((row) => row[field]);
  if (new Set(values).size !== values.length) {
    invalidData(`${collection}: ${field} duplicado`);
  }
}

function validateReferences(data, requireReference) {
  for (const client of data.clientes) {
    if (client.obra_social === 'Sin cobertura' && client.nro_afiliado !== null) {
      invalidData(`${client.id_cliente}: afiliado sin cobertura`);
    }
  }

  for (const pharmacist of data.farmaceuticos) {
    requireReference('sucursales', pharmacist.id_sucursal);
  }
  for (const product of data.productos) {
    requireReference('proveedores', product.id_proveedor);
  }
  for (const batch of data.stock_lotes) {
    requireReference('productos', batch.id_producto);
    requireReference('sucursales', batch.id_sucursal);
  }
  for (const prescription of data.recetas) {
    requireReference('clientes', prescription.id_cliente);
    if (prescription.dispensas_realizadas > prescription.dispensas_autorizadas) {
      invalidData(`${prescription.id_receta}: dispensas excedidas`);
    }
  }
}

function embedSaleItems(data, requireReference) {
  const itemsBySale = new Map(data.ventas.map((sale) => [sale.id_venta, []]));

  for (const { id_venta, ...item } of data.detalle_ventas) {
    requireReference('ventas', id_venta);
    requireReference('productos', item.id_producto);
    itemsBySale.get(id_venta).push(item);
  }

  return data.ventas.map((sale) => {
    requireReference('clientes', sale.id_cliente);
    const pharmacist = requireReference('farmaceuticos', sale.id_farmaceutico);
    const branch = requireReference('sucursales', pharmacist.id_sucursal);

    if (branch.tipo !== 'Farmacia') {
      invalidData(`${sale.id_venta}: venta en droguería`);
    }
    if (sale.id_receta) {
      const prescription = requireReference('recetas', sale.id_receta);
      if (prescription.id_cliente !== sale.id_cliente) {
        invalidData(`${sale.id_venta}: receta de otro cliente`);
      }
    }

    const items = itemsBySale.get(sale.id_venta);
    const total = items.reduce((sum, item) => sum + item.cantidad * item.precio_unit, 0);
    if (!items.length || !Number.isSafeInteger(total) || total !== sale.total) {
      invalidData(`${sale.id_venta}: total inconsistente o detalle vacío`);
    }

    return {
      ...sale,
      id_sucursal: pharmacist.id_sucursal,
      items,
      origen: 'importacion',
      stock_aplicado: sale.estado === 'Completada',
    };
  });
}

// Revisamos las referencias antes de guardar. Conservamos también los registros dados de baja
export function prepareData(provided) {
  const { data, recordsById } = indexRecords(provided);
  const requireReference = (name, id) => {
    const record = recordsById[name].get(id);
    if (!record) {
      invalidData(`Referencia inexistente: ${name}/${id}`);
    }
    return record;
  };

  validateUniqueField(data.clientes, 'clientes', 'dni');
  validateUniqueField(data.farmaceuticos, 'farmaceuticos', 'matricula');
  validateReferences(data, requireReference);

  data.ventas = embedSaleItems(data, requireReference);
  delete data.detalle_ventas;

  for (const rows of Object.values(data)) {
    for (const row of rows) {
      row.version = 1;
    }
  }

  return data;
}

export async function buildDataset({ adicionales = false } = {}) {
  const originales = await readProvided();
  if (!adicionales) {
    return prepareData(originales);
  }
  const propios = await readProvided(new URL('../../data/adicionales/', import.meta.url));
  return prepareData(
    Object.fromEntries(
      Object.entries(originales).map(([nombre, filas]) => [nombre, [...filas, ...propios[nombre]]]),
    ),
  );
}
