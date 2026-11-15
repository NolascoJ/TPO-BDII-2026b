import test from 'node:test';
import assert from 'node:assert/strict';
import { procesarOutbox, consultarOutbox, validarOpciones } from '../src/outbox/procesar.js';

test('procesador: límite predeterminado y selección por ID sin alterar opciones', () => {
  assert.deepEqual(validarOpciones(), { limite: 100, filtro: {} });
  const opciones = Object.freeze({ limite: 1, id_evento: 'cliente:C001:2' });
  assert.deepEqual(validarOpciones(opciones), {
    limite: 1,
    filtro: { id_evento: 'cliente:C001:2' },
  });
  assert.equal(validarOpciones({ limite: 1000 }).limite, 1000);
});

test('procesador y consulta: opciones inválidas se rechazan antes de acceder a MongoDB', async () => {
  for (const opciones of [
    null,
    [],
    'opciones',
    { todos: true },
    ...[null, 0, -1, 1.5, 1001, Infinity, '1'].map((limite) => ({ limite })),
    ...[null, '', ' ', 123, {}].map((id_evento) => ({ id_evento })),
  ]) {
    await assert.rejects(procesarOutbox({ db: null }, opciones), { code: 'PARAMETROS_INVALIDOS' });
    await assert.rejects(consultarOutbox({ db: null }, opciones), { code: 'PARAMETROS_INVALIDOS' });
  }
});
