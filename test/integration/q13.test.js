import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { q13 } from '../../src/queries/q13.js';
import { q14 } from '../../src/queries/q14.js';
import { snapshot } from './ventas-helpers.js';

const alta = (id_cliente, dni, datos = {}) => ({
  accion: 'alta',
  id_cliente,
  datos: {
    nombre: 'Ana',
    apellido: 'Pérez',
    dni,
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
    ...datos,
  },
});

test('q13 con MongoDB real: ABM, eventos atómicos, historial y concurrencia', async (t) => {
  const { client, db } = await connectMongo({
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  });
  const contexto = { client, db };
  const clientes = db.collection('clientes');
  const outbox = db.collection('outbox');
  const cliente = (id_cliente) => clientes.findOne({ id_cliente }, { projection: { _id: 0 } });
  const eventos = (id_entidad) =>
    outbox.find({ tipo_entidad: 'cliente', id_entidad }).sort({ version: 1 }).toArray();
  const ejecutar = (pedido) => q13(contexto, pedido);
  const modificar = (id_cliente, datos) => ejecutar({ accion: 'modificar', id_cliente, datos });
  const baja = (id_cliente) => ejecutar({ accion: 'baja', id_cliente });
  const rechazaSinEfectos = async (operacion, code) => {
    const antes = await snapshot(db);
    await assert.rejects(operacion(), { code });
    assert.deepEqual(await snapshot(db), antes);
  };
  const comprobarEvento = async (resultado) => {
    const c = resultado.cliente;
    const evento = await outbox.findOne({ id_evento: `cliente:${c.id_cliente}:${c.version}` });
    assert.ok(evento);
    assert.deepEqual(evento.contenido, c);
    assert.equal(evento.contenido._id, undefined);
    assert.equal(evento.estado, 'Pendiente');
    assert.equal(evento.intentos, 0);
    assert.equal(evento.ultimo_error, null);
    assert.equal(evento.procesado_en, null);
    assert.ok(evento.creado_en instanceof Date);
    assert.deepEqual(await cliente(c.id_cliente), c);
  };
  try {
    await ensureSchema(db);
    await loadData(client, db);

    await t.test('alta crea cliente activo y un evento con la instantánea completa', async () => {
      const pedido = alta('C-Q13', '00111222');
      const antes = structuredClone(pedido);
      const resultado = await ejecutar(pedido);
      assert.equal(resultado.modificado, true);
      assert.deepEqual(resultado.cliente, {
        ...pedido.datos,
        id_cliente: 'C-Q13',
        email: null,
        telefono: null,
        obra_social: 'Sin cobertura',
        nro_afiliado: null,
        activo: true,
        version: 1,
      });
      assert.deepEqual(pedido, antes);
      assert.equal((await eventos('C-Q13')).length, 1);
      await comprobarEvento(resultado);
      const conCobertura = await ejecutar(
        alta('C-Q13-OS', '00111223', {
          obra_social: 'OSDE',
          nro_afiliado: 'OS-01',
          email: 'ana@example.test',
        }),
      );
      assert.equal(conCobertura.cliente.nro_afiliado, 'OS-01');
      await comprobarEvento(conCobertura);
    });

    await t.test(
      'modifica parcialmente, aumenta versión y conserva eventos anteriores',
      async () => {
        const original = await cliente('C-Q13');
        const primerEvento = await eventos('C-Q13');
        const resultado = await modificar('C-Q13', {
          email: 'nuevo@example.test',
          telefono: '0111234',
          ciudad: 'Córdoba',
          provincia: 'Córdoba',
        });
        assert.deepEqual(resultado.cliente, {
          ...original,
          email: 'nuevo@example.test',
          telefono: '0111234',
          ciudad: 'Córdoba',
          provincia: 'Córdoba',
          version: 2,
        });
        await comprobarEvento(resultado);
        const registrados = await eventos('C-Q13');
        assert.deepEqual(
          registrados.map((e) => e.version),
          [1, 2],
        );
        assert.deepEqual(registrados[0], primerEvento[0]);
        const sinContacto = await modificar('C-Q13', { email: null, telefono: '' });
        assert.equal(sinContacto.cliente.email, null);
        assert.equal(sinContacto.cliente.telefono, null);
        assert.equal(sinContacto.cliente.version, 3);
        await comprobarEvento(sinContacto);
      },
    );

    await t.test(
      'cambiar cobertura limpia afiliados anteriores y permite indicar uno nuevo',
      async () => {
        const otra = await modificar('C-Q13-OS', { obra_social: 'PAMI' });
        assert.equal(otra.cliente.nro_afiliado, null);
        await comprobarEvento(otra);
        const afiliada = await modificar('C-Q13-OS', { nro_afiliado: 'PA-001' });
        assert.equal(afiliada.cliente.obra_social, 'PAMI');
        assert.equal(afiliada.cliente.nro_afiliado, 'PA-001');
        await comprobarEvento(afiliada);
        const sinCobertura = await modificar('C-Q13-OS', { obra_social: 'Sin cobertura' });
        assert.equal(sinCobertura.cliente.nro_afiliado, null);
        await comprobarEvento(sinCobertura);
        const original = await ejecutar(
          alta('C-Q13-SIN', '00111224', { nro_afiliado: 'se limpia' }),
        );
        assert.equal(original.cliente.nro_afiliado, null);
        await comprobarEvento(original);
      },
    );

    await t.test('repetir datos iguales no aumenta versión ni crea otro evento', async () => {
      const original = await cliente('C-Q13');
      const antes = await snapshot(db);
      const resultado = await modificar('C-Q13', {
        ciudad: original.ciudad,
        email: original.email,
      });
      assert.deepEqual(resultado, { cliente: original, modificado: false });
      assert.deepEqual(await snapshot(db), antes);
    });

    await t.test(
      'baja lógica conserva DNI e historial y repetirla no produce cambios',
      async () => {
        const antes = await snapshot(db);
        const original = await cliente('C001');
        const resultado = await baja('C001');
        assert.deepEqual(resultado.cliente, {
          ...original,
          activo: false,
          version: original.version + 1,
        });
        await comprobarEvento(resultado);
        const despues = await snapshot(db);
        for (const nombre of Object.keys(antes).filter(
          (n) => !['clientes', 'outbox'].includes(n),
        )) {
          assert.deepEqual(despues[nombre], antes[nombre], `${nombre} no debe cambiar`);
        }
        const repetido = await baja('C001');
        assert.deepEqual(repetido, { cliente: resultado.cliente, modificado: false });
        assert.deepEqual(await snapshot(db), despues);
        const corregido = await modificar('C001', { telefono: '01100000000' });
        assert.equal(corregido.cliente.activo, false);
        assert.equal(corregido.cliente.version, resultado.cliente.version + 1);
        await comprobarEvento(corregido);
      },
    );

    await t.test(
      'DNI e ID únicos, inexistentes y parámetros inválidos se rechazan sin efectos',
      async () => {
        await rechazaSinEfectos(() => ejecutar(alta('C-DUP', '31245678')), 'DNI_DUPLICADO');
        await rechazaSinEfectos(() => ejecutar(alta('C-DUP', '25678901')), 'DNI_DUPLICADO');
        await rechazaSinEfectos(() => ejecutar(alta('C001', '99911122')), 'ID_CLIENTE_DUPLICADO');
        await rechazaSinEfectos(() => ejecutar(alta('C-DUP', '00111222')), 'DNI_DUPLICADO');
        await rechazaSinEfectos(() => modificar('NO-EXISTE', { email: null }), 'CLIENTE_INVALIDO');
        await rechazaSinEfectos(() => baja('NO-EXISTE'), 'CLIENTE_INVALIDO');
        await rechazaSinEfectos(() => modificar('C001', { activo: true }), 'PARAMETROS_INVALIDOS');
        await rechazaSinEfectos(() => modificar('C001', { dni: '123' }), 'PARAMETROS_INVALIDOS');
        await rechazaSinEfectos(
          () => modificar('C001', { obra_social: 'Desconocida' }),
          'PARAMETROS_INVALIDOS',
        );
        await rechazaSinEfectos(() => ejecutar(alta('C-MAL', 123)), 'PARAMETROS_INVALIDOS');
      },
    );

    await t.test(
      'una falla de outbox revierte alta, modificación y baja; permite reintentar',
      async () => {
        const actual = await cliente('C-Q13');
        const pedidos = [
          [alta('C-FALLA', '00999000'), 1],
          [
            {
              accion: 'modificar',
              id_cliente: actual.id_cliente,
              datos: { email: 'fallo@example.test' },
            },
            actual.version + 1,
          ],
          [{ accion: 'baja', id_cliente: actual.id_cliente }, actual.version + 2],
        ];
        for (const [pedido, version] of pedidos) {
          const idEvento = `cliente:${pedido.id_cliente}:${version}`;
          await outbox.insertOne({
            id_evento: idEvento,
            tipo_entidad: 'cliente',
            id_entidad: pedido.id_cliente,
            version,
            contenido: { id_cliente: pedido.id_cliente, version },
            estado: 'Pendiente',
            intentos: 0,
            creado_en: new Date(),
            ultimo_error: null,
            procesado_en: null,
          });
          await rechazaSinEfectos(() => ejecutar(pedido), 11000);
          await outbox.deleteOne({ id_evento: idEvento });
          const resultado = await ejecutar(pedido);
          assert.equal(resultado.cliente.version, version);
          await comprobarEvento(resultado);
        }
      },
    );

    await t.test(
      'altas concurrentes con el mismo DNI confirman un solo cliente y evento',
      async () => {
        const resultados = await Promise.allSettled([
          ejecutar(alta('C-DNI-A', '00999111')),
          ejecutar(alta('C-DNI-B', '00999111')),
        ]);
        const exitos = resultados.filter((r) => r.status === 'fulfilled');
        const rechazos = resultados.filter((r) => r.status === 'rejected');
        assert.equal(exitos.length, 1);
        assert.equal(rechazos.length, 1);
        assert.equal(rechazos[0].reason.code, 'DNI_DUPLICADO');
        assert.equal(await clientes.countDocuments({ dni: '00999111' }), 1);
        assert.equal(
          await outbox.countDocuments({ id_entidad: { $in: ['C-DNI-A', 'C-DNI-B'] } }),
          1,
        );
        await comprobarEvento(exitos[0].value);
      },
    );

    await t.test(
      'altas concurrentes con el mismo ID se rechazan aunque difiera el DNI',
      async () => {
        const resultados = await Promise.allSettled([
          ejecutar(alta('C-ID', '00999221')),
          ejecutar(alta('C-ID', '00999222')),
        ]);
        assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
        const rechazos = resultados.filter((r) => r.status === 'rejected');
        assert.equal(rechazos.length, 1);
        assert.equal(rechazos[0].reason.code, 'ID_CLIENTE_DUPLICADO');
        assert.equal((await eventos('C-ID')).length, 1);
      },
    );

    await t.test(
      'cambios concurrentes preservan ambos campos y producen versiones sucesivas',
      async () => {
        const original = await cliente('C002');
        const resultados = await Promise.all([
          modificar('C002', { email: 'concurrente@example.test' }),
          modificar('C002', { telefono: '01111111111' }),
        ]);
        assert.ok(resultados.every((r) => r.modificado));
        const final = await cliente('C002');
        assert.equal(final.email, 'concurrente@example.test');
        assert.equal(final.telefono, '01111111111');
        assert.equal(final.version, original.version + 2);
        const registrados = await eventos('C002');
        assert.deepEqual(
          registrados.map((e) => e.version),
          [original.version + 1, original.version + 2],
        );
        assert.deepEqual(registrados[1].contenido, final);
        for (const resultado of resultados) {
          const evento = registrados.find((e) => e.version === resultado.cliente.version);
          assert.deepEqual(evento.contenido, resultado.cliente);
        }
      },
    );

    await t.test(
      'modificaciones idénticas y bajas concurrentes generan un solo cambio efectivo',
      async () => {
        const original = await cliente('C003');
        const cambios = await Promise.all(
          Array.from({ length: 4 }, () => modificar('C003', { email: 'igual@example.test' })),
        );
        assert.equal(cambios.filter((r) => r.modificado).length, 1);
        const bajas = await Promise.all(Array.from({ length: 4 }, () => baja('C003')));
        assert.equal(bajas.filter((r) => r.modificado).length, 1);
        assert.equal((await cliente('C003')).version, original.version + 2);
        assert.equal((await eventos('C003')).length, 2);
      },
    );

    await t.test(
      'baja y modificación concurrentes conservan la baja y el contacto nuevo',
      async () => {
        const original = await cliente('C004');
        await Promise.all([baja('C004'), modificar('C004', { email: 'baja@example.test' })]);
        const final = await cliente('C004');
        assert.equal(final.activo, false);
        assert.equal(final.email, 'baja@example.test');
        assert.equal(final.version, original.version + 2);
        const registrados = await eventos('C004');
        assert.equal(registrados.length, 2);
        assert.deepEqual(registrados[1].contenido, final);
      },
    );

    await t.test(
      'q14 respeta la baja y la pérdida de cobertura sin alterar ventas previas',
      async () => {
        const pedido = (id_cliente) => ({
          id_venta: 'V-Q13',
          id_cliente,
          id_farmaceutico: 'F001',
          medio_pago: 'Efectivo',
          items: [{ id_producto: 'PRD001', cantidad: 1 }],
        });
        await rechazaSinEfectos(() => q14(contexto, pedido('C001')), 'CLIENTE_INVALIDO');
        const antes = await snapshot(db);
        await modificar('C002', { obra_social: 'Sin cobertura' });
        assert.deepEqual((await snapshot(db)).ventas, antes.ventas);
        await rechazaSinEfectos(
          () => q14(contexto, { ...pedido('C002'), medio_pago: 'Obra social' }),
          'MEDIO_PAGO_INVALIDO',
        );
      },
    );
  } finally {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  }
});
