import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectMongo } from '../../src/db/connections.js';
import { config } from '../../src/config.js';
import { ensureSchema } from '../../src/db/schema.js';
import { loadData } from '../../src/data/load.js';
import { q14 } from '../../src/queries/q14.js';
import { ADVERTENCIA_RECETA_NO_UTILIZADA } from '../../src/services/venta/receta.js';
import {
  diasDesdeHoy,
  snapshot,
  lote,
  estadoInicial,
  assertInvariantes,
} from './ventas-helpers.js';

test('q14 con MongoDB real: ventas, recetas, eventos, rechazos sin efectos y concurrencia', async (t) => {
  const settings = {
    ...config(),
    mongoDatabase: `farmared_test_${randomUUID().replaceAll('-', '')}`,
  };
  const { client, db } = await connectMongo(settings);
  const contexto = { client, db };
  try {
    await ensureSchema(db);
    await loadData(client, db);
    const stock = db.collection('stock_lotes');
    const vencimientos = {
      L001: 300,
      L002: 300,
      L005: 10,
      L006: 200,
      L009: 200,
      L012: -1,
      L015: 200,
    };
    for (const [idLote, dias] of Object.entries(vencimientos)) {
      await stock.updateOne({ id_lote: idLote }, { $set: { vencimiento: diasDesdeHoy(dias) } });
    }
    const inicial = await estadoInicial(db);
    const receta = (idReceta) =>
      db.collection('recetas').findOne({ id_receta: idReceta }, { projection: { _id: 0 } });
    const eventos = (filtro) => db.collection('outbox').find(filtro).toArray();
    const pedido = (idVenta, cambios = {}) => ({
      id_venta: idVenta,
      id_cliente: 'C005',
      id_farmaceutico: 'F001',
      medio_pago: 'Efectivo',
      items: [{ id_producto: 'PRD001', cantidad: 1 }],
      ...cambios,
    });
    const rechazaSinEfectos = async (params, error) => {
      const antes = await snapshot(db);
      await assert.rejects(q14(contexto, params), error);
      assert.deepEqual(await snapshot(db), antes);
    };

    await t.test('venta libre: total, precio del catálogo, stock y evento de venta', async () => {
      const inicio = new Date();
      const {
        venta,
        receta: actualizada,
        movimientos,
        advertencias,
      } = await q14(
        contexto,
        pedido('V-T14-E1', { items: [{ id_producto: 'PRD001', cantidad: 2 }] }),
      );
      assert.equal(venta.total, 5600);
      assert.equal(venta.tipo, 'Venta libre');
      assert.equal(venta.id_receta, null);
      assert.equal(venta.id_sucursal, 'S001');
      assert.equal(venta.estado, 'Completada');
      assert.equal(venta.origen, 'operacion');
      assert.equal(venta.stock_aplicado, true);
      assert.ok(venta.fecha >= inicio && venta.fecha <= new Date());
      assert.deepEqual(venta.items, [
        { id_detalle: 'V-T14-E1-01', id_producto: 'PRD001', cantidad: 2, precio_unit: 2800 },
      ]);
      assert.equal(actualizada, null);
      assert.deepEqual(advertencias, []);
      assert.deepEqual(movimientos, [{ id_lote: 'L001', descontar: 2, id_producto: 'PRD001' }]);
      assert.equal((await lote(db, 'L001')).unidades, 118);

      const [evento, ...otros] = await eventos({ id_entidad: 'V-T14-E1' });
      assert.equal(otros.length, 0);
      assert.equal(evento.id_evento, 'venta:V-T14-E1:1');
      assert.equal(evento.estado, 'Pendiente');
      assert.equal(evento.intentos, 0);
      assert.equal(evento.contenido._id, undefined);
      assert.equal(evento.contenido.stock_aplicado, true);
    });

    await t.test('la venta conserva el precio aunque cambie el catálogo', async () => {
      const productos = db.collection('productos');
      await productos.updateOne({ id_producto: 'PRD001' }, { $set: { precio_unit: 99999 } });
      const venta = await db.collection('ventas').findOne({ id_venta: 'V-T14-E1' });
      assert.equal(venta.items[0].precio_unit, 2800);
      assert.equal(venta.total, 5600);
      await productos.updateOne({ id_producto: 'PRD001' }, { $set: { precio_unit: 2800 } });
    });

    await t.test('tratamiento prolongado: última dispensa completa la receta', async () => {
      const {
        venta,
        receta: actualizada,
        movimientos,
      } = await q14(
        contexto,
        pedido('V-T14-E2', {
          id_cliente: 'C006',
          id_farmaceutico: 'F002',
          id_receta: 'RC003',
          medio_pago: 'Obra social',
          items: [{ id_producto: 'PRD003', cantidad: 50 }],
        }),
      );
      assert.equal(venta.tipo, 'Con receta');
      assert.equal(venta.id_receta, 'RC003');
      assert.equal(venta.total, 490000);
      assert.deepEqual(movimientos, [
        { id_lote: 'L005', descontar: 40, id_producto: 'PRD003' },
        { id_lote: 'L015', descontar: 10, id_producto: 'PRD003' },
      ]);
      assert.equal(actualizada.dispensas_realizadas, 3);
      assert.equal(actualizada.estado, 'Completada');
      assert.equal(actualizada.proxima_dispensa, null);
      assert.equal(actualizada.version, 2);
      assert.deepEqual(await receta('RC003'), actualizada);

      const [eventoReceta, ...otros] = await eventos({ id_evento: 'receta:RC003:2' });
      assert.equal(otros.length, 0);
      assert.equal(eventoReceta.tipo_entidad, 'receta');
      assert.equal(eventoReceta.version, 2);
      assert.equal(eventoReceta.estado, 'Pendiente');
      assert.equal(eventoReceta.intentos, 0);
      assert.equal(eventoReceta.ultimo_error, null);
      assert.equal(eventoReceta.procesado_en, null);
      assert.equal(eventoReceta.contenido._id, undefined);
      assert.deepEqual(eventoReceta.contenido, actualizada);
      assert.equal((await eventos({ id_evento: 'venta:V-T14-E2:1' })).length, 1);
    });

    await t.test(
      'tratamiento prolongado: dispensa intermedia fija la próxima a 30 días',
      async () => {
        await q14(
          contexto,
          pedido('V-T14-E3', {
            id_cliente: 'C006',
            id_receta: 'RC004',
            items: [{ id_producto: 'PRD003', cantidad: 1 }],
          }),
        );
        const actualizada = await receta('RC004');
        assert.equal(actualizada.dispensas_realizadas, 2);
        assert.equal(actualizada.estado, 'Vigente');
        assert.deepEqual(actualizada.proxima_dispensa, diasDesdeHoy(30));
        assert.equal((await lote(db, 'L015')).unidades, 89);
      },
    );

    await t.test('receta simple: se completa con su única dispensa', async () => {
      await q14(
        contexto,
        pedido('V-T14-E4', {
          id_cliente: 'C007',
          id_farmaceutico: 'F006',
          id_receta: 'RC006',
          items: [{ id_producto: 'PRD003', cantidad: 1 }],
        }),
      );
      const actualizada = await receta('RC006');
      assert.equal(actualizada.dispensas_realizadas, 1);
      assert.equal(actualizada.estado, 'Completada');
      assert.equal((await lote(db, 'L006')).unidades, 74);
    });

    await t.test('una receta innecesaria se ignora con advertencia', async () => {
      const antes = await receta('RC004');
      const {
        venta,
        receta: actualizada,
        advertencias,
      } = await q14(contexto, pedido('V-T14-E6', { id_cliente: 'C006', id_receta: 'RC004' }));
      assert.equal(venta.tipo, 'Venta libre');
      assert.equal(venta.id_receta, null);
      assert.equal(actualizada, null);
      assert.deepEqual(advertencias, [ADVERTENCIA_RECETA_NO_UTILIZADA]);
      assert.deepEqual(await receta('RC004'), antes);
      assert.equal((await eventos({ id_entidad: 'V-T14-E6' })).length, 1);
      assert.equal((await eventos({ tipo_entidad: 'receta', id_entidad: 'RC004' })).length, 1);
    });

    await t.test('rechazos por validación o stock no dejan ningún efecto', async () => {
      const conReceta = (idReceta, idCliente, idProducto, cambios = {}) => ({
        id_cliente: idCliente,
        id_receta: idReceta,
        items: [{ id_producto: idProducto, cantidad: 1 }],
        ...cambios,
      });
      const casos = [
        [{ id_cliente: 'C-NO-EXISTE' }, 'CLIENTE_INVALIDO'],
        [{ id_cliente: 'C008' }, 'CLIENTE_INVALIDO'],
        // C005 no tiene cobertura
        [{ medio_pago: 'Obra social' }, 'MEDIO_PAGO_INVALIDO'],
        [{ id_farmaceutico: 'F-NO-EXISTE' }, 'FARMACEUTICO_INVALIDO'],
        [{ id_farmaceutico: 'F004' }, 'FARMACEUTICO_INVALIDO'],
        [{ id_farmaceutico: 'F007' }, 'FARMACEUTICO_INVALIDO'],
        [{ items: [{ id_producto: 'PRD-NO-EXISTE', cantidad: 1 }] }, 'PRODUCTO_INVALIDO'],
        [{ items: [{ id_producto: 'PRD012', cantidad: 1 }] }, 'PRODUCTO_INVALIDO'],
        [{ items: [{ id_producto: 'PRD003', cantidad: 1 }] }, 'RECETA_REQUERIDA'],
        [conReceta('RC-NO-EXISTE', 'C006', 'PRD003'), 'RECETA_INVALIDA'],
        [conReceta('RC009', 'C002', 'PRD003'), 'RECETA_INVALIDA'],
        [conReceta('RC001', 'C001', 'PRD003'), 'RECETA_INVALIDA'],
        [conReceta('RC006', 'C001', 'PRD003'), 'RECETA_INVALIDA'],
        [{ items: [] }, 'ITEMS_INVALIDOS'],
        [
          {
            id_cliente: 'C006',
            id_receta: 'RC004',
            items: [
              { id_producto: 'PRD001', cantidad: 1 },
              { id_producto: 'PRD006', cantidad: 61 },
            ],
          },
          'STOCK_INSUFICIENTE',
        ],
        [conReceta('RC004', 'C006', 'PRD010', { id_farmaceutico: 'F003' }), 'STOCK_INSUFICIENTE'],
        [conReceta('RC004', 'C006', 'PRD004'), 'STOCK_INSUFICIENTE'],
        // S001 tiene 120 unidades de PRD001; las 4000 de la droguería S005 no cuentan
        [{ items: [{ id_producto: 'PRD001', cantidad: 121 }] }, 'STOCK_INSUFICIENTE'],
        [
          { items: [{ id_producto: 'PRD001', cantidad: 1, precio_unit: 1 }] },
          'PARAMETROS_INVALIDOS',
        ],
        [{ fecha: '2020-01-01' }, 'PARAMETROS_INVALIDOS'],
      ];
      for (const [cambios, code] of casos) {
        await rechazaSinEfectos(pedido('V-T14-R', cambios), { code });
      }
    });

    await t.test('una sucursal dada de baja no puede registrar ventas', async () => {
      const sucursales = db.collection('sucursales');
      await sucursales.updateOne({ id_sucursal: 'S004' }, { $set: { activo: false } });
      try {
        await rechazaSinEfectos(pedido('V-T14-R19', { id_farmaceutico: 'F006' }), {
          code: 'SUCURSAL_INVALIDA',
        });
      } finally {
        await sucursales.updateOne({ id_sucursal: 'S004' }, { $set: { activo: true } });
      }
    });

    await t.test('una falla al registrar el evento revierte venta, stock y receta', async () => {
      const outbox = db.collection('outbox');
      await outbox.insertOne({
        id_evento: 'venta:V-T14-R18:1',
        tipo_entidad: 'venta',
        id_entidad: 'V-T14-R18',
        version: 1,
        contenido: {},
        estado: 'Pendiente',
        intentos: 0,
        creado_en: new Date(),
        ultimo_error: null,
        procesado_en: null,
      });
      try {
        await rechazaSinEfectos(
          pedido('V-T14-R18', {
            id_cliente: 'C006',
            id_receta: 'RC004',
            items: [{ id_producto: 'PRD003', cantidad: 1 }],
          }),
          { code: 11000 },
        );
      } finally {
        await outbox.deleteOne({ id_evento: 'venta:V-T14-R18:1' });
      }
    });

    await t.test('ventas concurrentes no consumen más dispensas que las autorizadas', async () => {
      const unidadesAntes = (await lote(db, 'L015')).unidades;
      const resultados = await Promise.allSettled(
        Array.from({ length: 3 }, (_, indice) =>
          q14(
            contexto,
            pedido(`V-T14-C2-${indice}`, {
              id_cliente: 'C003',
              id_receta: 'RC002',
              items: [{ id_producto: 'PRD003', cantidad: 1 }],
            }),
          ),
        ),
      );
      const exitos = resultados.filter((r) => r.status === 'fulfilled');
      const rechazos = resultados.filter((r) => r.status === 'rejected');
      assert.equal(exitos.length, 1);
      assert.ok(rechazos.every((r) => r.reason.code === 'RECETA_INVALIDA'));
      const actualizada = await receta('RC002');
      assert.equal(actualizada.dispensas_realizadas, 3);
      assert.equal(actualizada.estado, 'Completada');
      assert.equal((await lote(db, 'L015')).unidades, unidadesAntes - 1);
      assert.equal((await eventos({ tipo_entidad: 'receta', id_entidad: 'RC002' })).length, 1);
      assert.equal(await db.collection('ventas').countDocuments({ id_venta: /^V-T14-C2-/ }), 1);
    });

    await t.test(
      'ventas concurrentes con q14 sobre el mismo lote no generan sobreventa',
      async () => {
        // L002 tiene 35 unidades de PRD001 en S002: alcanzan para 8 ventas de 4 unidades
        assert.equal((await lote(db, 'L002')).unidades, 35);
        const resultados = await Promise.allSettled(
          Array.from({ length: 10 }, (_, indice) =>
            q14(
              contexto,
              pedido(`V-T14-C1-${indice}`, {
                id_farmaceutico: 'F003',
                items: [{ id_producto: 'PRD001', cantidad: 4 }],
              }),
            ),
          ),
        );
        const exitos = resultados.filter((r) => r.status === 'fulfilled');
        const rechazos = resultados.filter((r) => r.status === 'rejected');
        assert.equal(exitos.length, 8);
        assert.ok(rechazos.every((r) => r.reason.code === 'STOCK_INSUFICIENTE'));
        assert.equal((await lote(db, 'L002')).unidades, 3);
        assert.equal(await db.collection('ventas').countDocuments({ id_venta: /^V-T14-C1-/ }), 8);
        assert.equal(await db.collection('outbox').countDocuments({ id_entidad: /^V-T14-C1-/ }), 8);
      },
    );

    await t.test('se cumplen los invariantes después de todas las operaciones', () =>
      assertInvariantes(db, inicial),
    );
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
