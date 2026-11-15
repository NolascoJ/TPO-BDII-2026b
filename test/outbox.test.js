import test from 'node:test';
import assert from 'node:assert/strict';
import { registrarEvento } from '../src/outbox/registrar.js';

const transaccion = { inTransaction: () => true };
const eventoValido = {
  tipo_entidad: 'cliente',
  id_entidad: 'C001',
  version: 2,
  contenido: { id_cliente: 'C001', version: 2 },
};
const sinEscrituras = {
  collection() {
    assert.fail('No debe acceder a la colección si el contrato es inválido');
  },
};

test('outbox: exige una sesión con transacción activa antes de escribir', async () => {
  for (const session of [undefined, null, { inTransaction: () => false }]) {
    await assert.rejects(registrarEvento(sinEscrituras, session, eventoValido), {
      code: 'TRANSACCION_REQUERIDA',
    });
  }
});

test('outbox: rechaza eventos sin identidad, versión o contenido coherentes', async () => {
  const invalidos = [
    undefined,
    null,
    {},
    { ...eventoValido, tipo_entidad: 'stock' },
    { ...eventoValido, tipo_entidad: 'constructor' },
    ...['', ' ', null, 1].map((id_entidad) => ({ ...eventoValido, id_entidad })),
    ...[0, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((version) => ({
      ...eventoValido,
      version,
      contenido: { ...eventoValido.contenido, version },
    })),
    ...[
      undefined,
      null,
      [],
      'cliente',
      {},
      { id_cliente: 'C002', version: 2 },
      { id_cliente: 'C001', version: 1 },
    ].map((contenido) => ({ ...eventoValido, contenido })),
  ];
  for (const evento of invalidos) {
    await assert.rejects(registrarEvento(sinEscrituras, transaccion, evento), {
      code: 'EVENTO_INVALIDO',
    });
  }
});

test('outbox: admite los cinco tipos y conserva la instantánea sin mutar el origen', async () => {
  for (const tipo of ['cliente', 'receta', 'venta', 'farmaceutico', 'sucursal']) {
    const contenido = Object.freeze({
      _id: 'id-interno',
      [`id_${tipo}`]: 'ID001',
      version: 2,
      activo: false,
      contacto: null,
      fecha: new Date('2026-01-01T00:00:00Z'),
      items: [{ cantidad: 3 }],
    });
    const antes = structuredClone(contenido);
    const inicio = new Date();
    let documento;
    const db = {
      collection(nombre) {
        assert.equal(nombre, 'outbox');
        return {
          async insertOne(valor, opciones) {
            assert.equal(opciones.session, transaccion);
            documento = valor;
          },
        };
      },
    };
    await registrarEvento(db, transaccion, {
      tipo_entidad: tipo,
      id_entidad: 'ID001',
      version: 2,
      contenido,
    });
    const { _id, ...esperado } = antes;
    assert.deepEqual(documento, {
      id_evento: `${tipo}:ID001:2`,
      tipo_entidad: tipo,
      id_entidad: 'ID001',
      version: 2,
      contenido: esperado,
      estado: 'Pendiente',
      intentos: 0,
      creado_en: documento.creado_en,
      ultimo_error: null,
      procesado_en: null,
    });
    assert.ok(documento.creado_en instanceof Date);
    assert.ok(documento.creado_en >= inicio && documento.creado_en <= new Date());
    assert.deepEqual(contenido, antes);
  }
});

test('outbox: propaga errores de escritura para que el servicio aborte', async () => {
  const error = Object.assign(new Error('Duplicado'), { code: 11000 });
  const db = {
    collection: () => ({
      insertOne: async () => {
        throw error;
      },
    }),
  };
  await assert.rejects(
    registrarEvento(db, transaccion, eventoValido),
    (recibido) => recibido === error,
  );
});
