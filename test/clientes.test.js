import test from 'node:test';
import assert from 'node:assert/strict';
import { validarSolicitud, aplicarDatos } from '../src/services/cliente/datos.js';

const alta = () => ({
  accion: 'alta',
  id_cliente: 'C-NUEVO',
  datos: {
    nombre: 'Ana',
    apellido: 'Pérez',
    dni: '00123456',
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
  },
});

test('q13: alta normaliza espacios y nulos sin modificar el pedido ni perder ceros', () => {
  const pedido = alta();
  pedido.datos.nombre = ' Ana ';
  pedido.datos.dni = ' 00123456 ';
  pedido.datos.email = '  ';
  pedido.datos.telefono = ' 01112345678 ';
  const antes = structuredClone(pedido);
  const normalizado = validarSolicitud(pedido);
  assert.deepEqual(normalizado.datos, {
    nombre: 'Ana',
    apellido: 'Pérez',
    dni: '00123456',
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
    email: null,
    telefono: '01112345678',
    obra_social: 'Sin cobertura',
    nro_afiliado: null,
  });
  assert.deepEqual(pedido, antes);
});

test('q13: modificación distingue campos omitidos de contactos que se quieren borrar', () => {
  assert.deepEqual(
    validarSolicitud({
      accion: 'modificar',
      id_cliente: 'C001',
      datos: { email: null, telefono: '' },
    }),
    { accion: 'modificar', id_cliente: 'C001', datos: { email: null, telefono: null } },
  );
  assert.deepEqual(validarSolicitud({ accion: 'baja', id_cliente: 'C001' }), {
    accion: 'baja',
    id_cliente: 'C001',
  });
});

test('q13: rechaza parámetros incompletos, tipos incorrectos y campos fuera del ABM', () => {
  const invalidos = [
    null,
    [],
    {},
    { ...alta(), accion: 'reactivar' },
    ...[null, '', ' ', 123].map((id_cliente) => ({ ...alta(), id_cliente })),
    ...[null, [], 'datos', {}].map((datos) => ({ ...alta(), datos })),
    ...['nombre', 'apellido', 'dni', 'ciudad', 'provincia'].map((campo) => ({
      ...alta(),
      datos: { ...alta().datos, [campo]: '' },
    })),
    ...['email', 'telefono', 'nro_afiliado', 'dni'].map((campo) => ({
      ...alta(),
      datos: { ...alta().datos, [campo]: 123 },
    })),
    ...['activo', 'version', '_id', 'id_cliente', '$set'].map((campo) => ({
      ...alta(),
      datos: { ...alta().datos, [campo]: 'no permitido' },
    })),
    { ...alta(), version: 2 },
    { ...alta(), datos: { ...alta().datos, obra_social: 'Desconocida' } },
    { accion: 'modificar', id_cliente: 'C001', datos: {} },
    ...['dni', 'nombre', 'apellido', 'activo', 'version', 'id_cliente', '$unset'].map((campo) => ({
      accion: 'modificar',
      id_cliente: 'C001',
      datos: { [campo]: 'no permitido' },
    })),
    { accion: 'baja', id_cliente: 'C001', datos: {} },
  ];
  for (const pedido of invalidos) {
    assert.throws(() => validarSolicitud(pedido), { code: 'PARAMETROS_INVALIDOS' });
  }
});

test('q13: acepta las coberturas del modelo y afiliado nulo', () => {
  for (const obra_social of ['OSDE', 'Swiss Medical', 'PAMI', 'IOMA', 'Galeno', 'Sin cobertura']) {
    const pedido = validarSolicitud({ ...alta(), datos: { ...alta().datos, obra_social } });
    assert.equal(pedido.datos.obra_social, obra_social);
    assert.equal(pedido.datos.nro_afiliado, null);
  }
});

test('q13: cobertura coherente, cambios parciales y argumentos intactos', () => {
  const actual = Object.freeze({
    obra_social: 'OSDE',
    nro_afiliado: 'OS-01',
    email: 'a@example.test',
  });
  const cambio = Object.freeze({ obra_social: 'Sin cobertura', nro_afiliado: 'ignorado' });
  assert.deepEqual(aplicarDatos(actual, cambio), {
    ...actual,
    obra_social: 'Sin cobertura',
    nro_afiliado: null,
  });
  assert.deepEqual(aplicarDatos(actual, { obra_social: 'PAMI' }), {
    ...actual,
    obra_social: 'PAMI',
    nro_afiliado: null,
  });
  assert.deepEqual(aplicarDatos(actual, { obra_social: 'PAMI', nro_afiliado: 'PA-01' }), {
    ...actual,
    obra_social: 'PAMI',
    nro_afiliado: 'PA-01',
  });
  assert.deepEqual(aplicarDatos(actual, { obra_social: 'OSDE' }), actual);
  assert.deepEqual(aplicarDatos(actual, { email: null }), { ...actual, email: null });
  assert.equal(actual.nro_afiliado, 'OS-01');
  assert.equal(cambio.nro_afiliado, 'ignorado');
});
