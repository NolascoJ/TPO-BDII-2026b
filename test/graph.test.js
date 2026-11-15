import test from 'node:test';
import assert from 'node:assert/strict';
import neo4j from 'neo4j-driver';
import { aDateTime, mapCliente, mapFarmaceutico, mapReceta, mapVenta } from '../src/graph/mapeo.js';
import { ultimos60Dias, ultimoAnio } from '../src/graph/periodos.js';
import { aJs } from '../src/graph/valores.js';

test('aDateTime: convierte a UTC sin depender de la zona horaria y conserva null', () => {
  const dt = aDateTime(new Date('2026-10-08T21:30:15.250Z'));
  assert.equal(Number(dt.year), 2026);
  assert.equal(Number(dt.month), 10);
  assert.equal(Number(dt.day), 8);
  assert.equal(Number(dt.hour), 21);
  assert.equal(Number(dt.minute), 30);
  assert.equal(Number(dt.second), 15);
  assert.equal(Number(dt.nanosecond), 250_000_000);
  assert.equal(Number(dt.timeZoneOffsetSeconds), 0);
  assert.equal(dt.toStandardDate().toISOString(), '2026-10-08T21:30:15.250Z');
  assert.equal(aDateTime(null), null);
  assert.equal(aDateTime(undefined), null);
  assert.throws(() => aDateTime('2026-10-08'), TypeError);
  assert.throws(() => aDateTime(new Date('x')), TypeError);
});

test('mapCliente: solo propiedades de negocio, nulos explícitos y versión entera', () => {
  const { props } = mapCliente({
    _id: 'interno',
    id_cliente: 'C005',
    nombre: 'Sofía',
    apellido: 'Benavídez',
    dni: '37456123',
    email: 'sofia.b@gmail.com',
    telefono: '3416556677',
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
    obra_social: 'Sin cobertura',
    nro_afiliado: null,
    activo: true,
    version: 3,
  });
  assert.equal(props._id, undefined);
  assert.equal(props.nro_afiliado, null);
  assert.ok(neo4j.isInt(props.version));
  assert.equal(props.version.toNumber(), 3);
});

test('mapFarmaceutico: la sucursal queda fuera de las propiedades, para la relación', () => {
  const fila = mapFarmaceutico({
    id_farmaceutico: 'F004',
    nombre: 'Julián',
    apellido: 'Pereyra',
    matricula: 'MN-17955',
    cargo: 'Farmacéutico',
    id_sucursal: 'S002',
    activo: false,
    version: 1,
  });
  assert.equal(fila.id_sucursal, 'S002');
  assert.equal(fila.props.id_sucursal, undefined);
  assert.equal(fila.props.activo, false);
});

test('mapReceta: fechas como DateTime, próxima dispensa nula y enteros', () => {
  const fila = mapReceta({
    id_receta: 'RC001',
    id_cliente: 'C001',
    medico: 'Dr. Alejandro Vidal',
    matricula_medico: 'MP-45210',
    fecha_emision: new Date('2026-09-10T00:00:00Z'),
    tipo: 'Simple',
    dispensas_autorizadas: 1,
    dispensas_realizadas: 1,
    proxima_dispensa: null,
    estado: 'Completada',
    version: 1,
  });
  assert.equal(fila.id_cliente, 'C001');
  assert.ok(fila.props.fecha_emision instanceof neo4j.types.DateTime);
  assert.equal(fila.props.proxima_dispensa, null);
  assert.ok(neo4j.isInt(fila.props.dispensas_realizadas));
});

test('mapVenta: referencias aparte, ítems como lista para relaciones y sin campos técnicos', () => {
  const fila = mapVenta({
    _id: 'interno',
    id_venta: 'V013',
    id_cliente: 'C001',
    id_farmaceutico: 'F001',
    id_sucursal: 'S001',
    id_receta: null,
    fecha: new Date('2026-10-02T00:00:00Z'),
    tipo: 'Venta libre',
    medio_pago: 'Efectivo',
    total: 4400,
    estado: 'Completada',
    stock_aplicado: true,
    origen: 'importacion',
    version: 1,
    items: [{ id_detalle: 'D017', id_producto: 'PRD001', cantidad: 2, precio_unit: 2200 }],
  });
  assert.deepEqual(Object.keys(fila.props).sort(), [
    'estado',
    'fecha',
    'id_venta',
    'medio_pago',
    'origen',
    'tipo',
    'total',
    'version',
  ]);
  assert.equal(fila.id_receta, null);
  assert.equal(fila.id_sucursal, 'S001');
  assert.equal(fila.items.length, 1);
  assert.equal(fila.items[0].cantidad.toNumber(), 2);
  assert.equal(fila.items[0].precio_unit.toNumber(), 2200);
});

test('ultimos60Dias: ventana de 60 días que termina ahora', () => {
  const ahora = new Date('2026-11-15T14:00:00Z');
  const { desde, hasta } = ultimos60Dias(ahora);
  assert.equal(desde.toISOString(), '2026-09-16T14:00:00.000Z');
  assert.equal(hasta.toISOString(), ahora.toISOString());
});

test('ultimoAnio: mismo instante del año anterior y 29/2 ajustado a 28/2', () => {
  assert.equal(
    ultimoAnio(new Date('2026-11-15T14:00:00Z')).desde.toISOString(),
    '2025-11-15T14:00:00.000Z',
  );
  assert.equal(
    ultimoAnio(new Date('2028-02-29T10:30:00Z')).desde.toISOString(),
    '2027-02-28T10:30:00.000Z',
  );
  assert.equal(
    ultimoAnio(new Date('2027-03-01T00:00:00Z')).desde.toISOString(),
    '2026-03-01T00:00:00.000Z',
  );
});

test('aJs: enteros a number, fechas a Date y estructuras anidadas', () => {
  const fecha = new Date('2026-10-02T15:04:05.000Z');
  assert.deepEqual(
    aJs({
      n: neo4j.int(7),
      f: aDateTime(fecha),
      lista: [neo4j.int(1), { x: null, s: 'a', b: false }],
    }),
    { n: 7, f: fecha, lista: [1, { x: null, s: 'a', b: false }] },
  );
  assert.equal(aJs(undefined), null);
});
