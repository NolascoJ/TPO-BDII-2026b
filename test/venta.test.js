import test from 'node:test';
import assert from 'node:assert/strict';
import { inicioDiaUTC, sumarDiasUTC } from '../src/services/venta/fechas.js';
import {
  validarPedido,
  construirItems,
  calcularTotal,
  diferenciasConVenta,
  validarMedioPago,
} from '../src/services/venta/pedido.js';
import {
  resolverReceta,
  validarReceta,
  siguienteEstadoReceta,
  ADVERTENCIA_RECETA_NO_UTILIZADA,
} from '../src/services/venta/receta.js';
import {
  planificarFefo,
  lotesVigentesFefo,
  agruparCantidades,
} from '../src/services/venta/fefo.js';

const fecha = (texto) => new Date(texto);
const pedidoBase = () => ({
  id_venta: 'V-T01',
  id_cliente: 'C006',
  id_farmaceutico: 'F002',
  id_receta: 'RC003',
  medio_pago: 'Obra social',
  items: [{ id_producto: 'PRD003', cantidad: 50 }],
});
const codigo = (code) => ({ code });

test('fechas: inicio del día y suma de días en UTC', () => {
  assert.equal(
    inicioDiaUTC(fecha('2026-11-14T23:59:59.999Z')).toISOString(),
    '2026-11-14T00:00:00.000Z',
  );
  assert.equal(
    sumarDiasUTC(fecha('2026-12-15T00:00:00Z'), 30).toISOString(),
    '2027-01-14T00:00:00.000Z',
  );
  const original = fecha('2026-11-14T10:00:00Z');
  sumarDiasUTC(original, 30);
  assert.equal(original.toISOString(), '2026-11-14T10:00:00.000Z');
  assert.throws(() => inicioDiaUTC(new Date('no es fecha')), TypeError);
});

test('validarPedido: normaliza un pedido válido sin modificar el original', () => {
  const pedido = pedidoBase();
  delete pedido.id_receta;
  const copia = structuredClone(pedido);
  const resultado = validarPedido(pedido);
  assert.equal(resultado.id_receta, null);
  assert.deepEqual(resultado.items, [{ id_producto: 'PRD003', cantidad: 50 }]);
  assert.notEqual(resultado.items, pedido.items);
  assert.deepEqual(pedido, copia);
});

test('validarPedido: rechaza campos no permitidos en cabecera e ítems', () => {
  for (const extra of [{ precio_unit: 1 }, { fecha: '2026-01-01' }, { estado: 'Pendiente' }]) {
    assert.throws(
      () => validarPedido({ ...pedidoBase(), ...extra }),
      codigo('PARAMETROS_INVALIDOS'),
    );
  }
  const pedido = pedidoBase();
  pedido.items[0].precio_unit = 1;
  assert.throws(() => validarPedido(pedido), {
    code: 'PARAMETROS_INVALIDOS',
    details: { campos: ['precio_unit'] },
  });
});

test('validarPedido: exige IDs, medio de pago válido y receta string o nula', () => {
  for (const cambio of [
    { id_venta: '' },
    { id_cliente: '   ' },
    { id_farmaceutico: 7 },
    { id_receta: 3 },
    { medio_pago: 'Cheque' },
    { medio_pago: undefined },
  ]) {
    assert.throws(
      () => validarPedido({ ...pedidoBase(), ...cambio }),
      codigo('PARAMETROS_INVALIDOS'),
    );
  }
  for (const noObjeto of [null, [], 'pedido']) {
    assert.throws(() => validarPedido(noObjeto), codigo('PARAMETROS_INVALIDOS'));
  }
});

test('validarPedido: rechaza ítems vacíos, cantidades inválidas y productos repetidos', () => {
  const casos = [
    [],
    undefined,
    [null],
    [{ id_producto: '', cantidad: 1 }],
    [{ id_producto: 'PRD001', cantidad: 0 }],
    [{ id_producto: 'PRD001', cantidad: -1 }],
    [{ id_producto: 'PRD001', cantidad: 1.5 }],
    [{ id_producto: 'PRD001', cantidad: '2' }],
    [
      { id_producto: 'PRD001', cantidad: 1 },
      { id_producto: 'PRD001', cantidad: 2 },
    ],
  ];
  for (const items of casos) {
    assert.throws(() => validarPedido({ ...pedidoBase(), items }), codigo('ITEMS_INVALIDOS'));
  }
});

test('construirItems: precio del catálogo e id_detalle determinista', () => {
  const productos = [
    { id_producto: 'PRD001', precio_unit: 2800, activo: true },
    { id_producto: 'PRD003', precio_unit: 9800, activo: true },
  ];
  const items = construirItems(
    'V-T01',
    [
      { id_producto: 'PRD003', cantidad: 1 },
      { id_producto: 'PRD001', cantidad: 2 },
    ],
    productos,
  );
  assert.deepEqual(items, [
    { id_detalle: 'V-T01-01', id_producto: 'PRD003', cantidad: 1, precio_unit: 9800 },
    { id_detalle: 'V-T01-02', id_producto: 'PRD001', cantidad: 2, precio_unit: 2800 },
  ]);
  assert.equal(calcularTotal(items), 15400);
});

test('construirItems: rechaza productos inexistentes o inactivos', () => {
  const productos = [{ id_producto: 'PRD012', precio_unit: 1800, activo: false }];
  for (const idProducto of ['PRD012', 'NO-EXISTE']) {
    assert.throws(
      () => construirItems('V-T01', [{ id_producto: idProducto, cantidad: 1 }], productos),
      { code: 'PRODUCTO_INVALIDO', details: { id_producto: idProducto } },
    );
  }
});

test('calcularTotal: rechaza totales fuera del rango de enteros seguros', () => {
  assert.throws(
    () => calcularTotal([{ cantidad: Number.MAX_SAFE_INTEGER, precio_unit: 2 }]),
    codigo('ITEMS_INVALIDOS'),
  );
});

test('resolverReceta: tipo de venta y receta según los productos', () => {
  const libre = { id_producto: 'PRD001', condicion_venta: 'Venta libre' };
  const bajoReceta = { id_producto: 'PRD003', condicion_venta: 'Bajo receta' };
  const archivada = { id_producto: 'PRD008', condicion_venta: 'Bajo receta archivada' };

  assert.deepEqual(resolverReceta([libre], null), {
    tipo: 'Venta libre',
    id_receta: null,
    advertencias: [],
  });
  assert.deepEqual(resolverReceta([libre], 'RC004'), {
    tipo: 'Venta libre',
    id_receta: null,
    advertencias: [ADVERTENCIA_RECETA_NO_UTILIZADA],
  });
  assert.deepEqual(resolverReceta([libre, bajoReceta], 'RC003'), {
    tipo: 'Con receta',
    id_receta: 'RC003',
    advertencias: [],
  });
  assert.throws(() => resolverReceta([libre, bajoReceta, archivada], null), {
    code: 'RECETA_REQUERIDA',
    details: { productos: ['PRD003', 'PRD008'] },
  });
});

test('validarReceta: existente, del mismo cliente, vigente y con dispensas', () => {
  const vigente = {
    id_receta: 'RC004',
    id_cliente: 'C006',
    tipo: 'Tratamiento prolongado',
    dispensas_autorizadas: 3,
    dispensas_realizadas: 1,
    estado: 'Vigente',
  };
  const pedido = { id_receta: 'RC004', id_cliente: 'C006' };
  assert.doesNotThrow(() => validarReceta(vigente, pedido));

  const invalidas = [
    null,
    { ...vigente, id_cliente: 'C001' },
    { ...vigente, estado: 'Vencida' },
    { ...vigente, estado: 'Completada' },
    { ...vigente, dispensas_realizadas: 3 },
  ];
  for (const receta of invalidas) {
    assert.throws(() => validarReceta(receta, pedido), codigo('RECETA_INVALIDA'));
  }
});

test('siguienteEstadoReceta: transiciones de dispensa sin modificar la receta', () => {
  const venta = fecha('2026-11-14T15:30:00Z');
  const simple = {
    tipo: 'Simple',
    dispensas_autorizadas: 1,
    dispensas_realizadas: 0,
    estado: 'Vigente',
  };
  const esperadoCompleta = (realizadas) => ({
    dispensas_realizadas: realizadas,
    proxima_dispensa: null,
    estado: 'Completada',
  });

  assert.deepEqual(siguienteEstadoReceta(simple, venta), esperadoCompleta(1));
  assert.deepEqual(
    siguienteEstadoReceta({ ...simple, tipo: 'Archivada' }, venta),
    esperadoCompleta(1),
  );

  const prolongada = {
    tipo: 'Tratamiento prolongado',
    dispensas_autorizadas: 3,
    dispensas_realizadas: 1,
    estado: 'Vigente',
  };
  const copia = structuredClone(prolongada);
  const intermedia = siguienteEstadoReceta(prolongada, venta);
  assert.deepEqual(intermedia, {
    dispensas_realizadas: 2,
    proxima_dispensa: fecha('2026-12-14T00:00:00Z'),
    estado: 'Vigente',
  });
  assert.deepEqual(prolongada, copia);
  assert.deepEqual(
    siguienteEstadoReceta({ ...prolongada, dispensas_realizadas: 2 }, venta),
    esperadoCompleta(3),
  );
});

test('FEFO: consume primero el lote que vence antes y reparte entre lotes', () => {
  const lotes = [
    { id_lote: 'L015', unidades: 100, vencimiento: fecha('2027-06-30T00:00:00Z') },
    { id_lote: 'L005', unidades: 40, vencimiento: fecha('2026-11-30T00:00:00Z') },
  ];
  const copia = structuredClone(lotes);
  const ahora = fecha('2026-11-14T12:00:00Z');
  assert.deepEqual(planificarFefo(lotes, { id_producto: 'PRD003', cantidad: 50 }, ahora), [
    { id_lote: 'L005', descontar: 40 },
    { id_lote: 'L015', descontar: 10 },
  ]);
  assert.deepEqual(planificarFefo(lotes, { id_producto: 'PRD003', cantidad: 5 }, ahora), [
    { id_lote: 'L005', descontar: 5 },
  ]);
  assert.deepEqual(lotes, copia);
});

test('FEFO: un lote que vence hoy se usa todo el día; uno vencido ayer no', () => {
  const lotes = [
    { id_lote: 'L-AYER', unidades: 10, vencimiento: fecha('2026-11-29T00:00:00Z') },
    { id_lote: 'L-HOY', unidades: 10, vencimiento: fecha('2026-11-30T00:00:00Z') },
  ];
  const ultimoMomentoDelDia = fecha('2026-11-30T23:59:59.999Z');
  assert.deepEqual(
    planificarFefo(lotes, { id_producto: 'PRD003', cantidad: 10 }, ultimoMomentoDelDia),
    [{ id_lote: 'L-HOY', descontar: 10 }],
  );
  assert.throws(
    () => planificarFefo(lotes, { id_producto: 'PRD003', cantidad: 1 }, fecha('2026-12-01')),
    { code: 'STOCK_INSUFICIENTE', details: { id_producto: 'PRD003', requerido: 1, disponible: 0 } },
  );
});

test('FEFO: desempata por id_lote y omite lotes sin unidades', () => {
  const vencimiento = fecha('2027-01-31T00:00:00Z');
  const lotes = [
    { id_lote: 'L020', unidades: 5, vencimiento },
    { id_lote: 'L010', unidades: 0, vencimiento },
    { id_lote: 'L012', unidades: 5, vencimiento },
  ];
  const ahora = fecha('2026-11-14T00:00:00Z');
  assert.deepEqual(
    lotesVigentesFefo(lotes, ahora).map((lote) => lote.id_lote),
    ['L012', 'L020'],
  );
  assert.deepEqual(planificarFefo(lotes, { id_producto: 'PRD008', cantidad: 7 }, ahora), [
    { id_lote: 'L012', descontar: 5 },
    { id_lote: 'L020', descontar: 2 },
  ]);
});

test('FEFO: stock vigente insuficiente informa requerido y disponible', () => {
  const lotes = [
    { id_lote: 'L009', unidades: 60, vencimiento: fecha('2027-06-30T00:00:00Z') },
    { id_lote: 'L-VENCIDO', unidades: 500, vencimiento: fecha('2026-10-31T00:00:00Z') },
  ];
  assert.throws(
    () =>
      planificarFefo(lotes, { id_producto: 'PRD006', cantidad: 61 }, fecha('2026-11-14T00:00Z')),
    {
      code: 'STOCK_INSUFICIENTE',
      details: { id_producto: 'PRD006', requerido: 61, disponible: 60 },
    },
  );
  assert.throws(
    () => planificarFefo([], { id_producto: 'PRD004', cantidad: 1 }, fecha('2026-11-14T00:00Z')),
    codigo('STOCK_INSUFICIENTE'),
  );
});

test('agruparCantidades: suma por producto', () => {
  assert.deepEqual(
    [
      ...agruparCantidades([
        { id_producto: 'PRD001', cantidad: 2 },
        { id_producto: 'PRD003', cantidad: 1 },
        { id_producto: 'PRD001', cantidad: 3 },
      ]),
    ],
    [
      ['PRD001', 5],
      ['PRD003', 1],
    ],
  );
});

test('diferenciasConVenta: reconoce el mismo pedido y lista los campos distintos', () => {
  const pedido = validarPedido(pedidoBase());
  const venta = {
    ...pedido,
    tipo: 'Con receta',
    items: [{ id_detalle: 'V-T01-01', id_producto: 'PRD003', cantidad: 50, precio_unit: 9800 }],
  };
  assert.deepEqual(diferenciasConVenta(venta, pedido), []);

  const otro = validarPedido({
    ...pedidoBase(),
    id_cliente: 'C001',
    medio_pago: 'Efectivo',
    id_receta: null,
    items: [{ id_producto: 'PRD003', cantidad: 49 }],
  });
  assert.deepEqual(diferenciasConVenta(venta, otro), [
    'id_cliente',
    'medio_pago',
    'id_receta',
    'items',
  ]);
  const masItems = validarPedido({
    ...pedidoBase(),
    items: [
      { id_producto: 'PRD003', cantidad: 50 },
      { id_producto: 'PRD001', cantidad: 1 },
    ],
  });
  assert.deepEqual(diferenciasConVenta(venta, masItems), ['items']);
});

test('diferenciasConVenta: una receta ignorada en una venta libre no es diferencia', () => {
  const pedido = validarPedido({
    ...pedidoBase(),
    id_receta: 'RC004',
    items: [{ id_producto: 'PRD001', cantidad: 1 }],
  });
  const venta = {
    ...pedido,
    id_receta: null,
    tipo: 'Venta libre',
    items: [{ id_detalle: 'V-T01-01', id_producto: 'PRD001', cantidad: 1, precio_unit: 2800 }],
  };
  assert.deepEqual(diferenciasConVenta(venta, pedido), []);
  assert.deepEqual(diferenciasConVenta(venta, { ...pedido, id_receta: null }), []);
});

test('validarMedioPago: obra social solo para clientes con cobertura', () => {
  const sinCobertura = { id_cliente: 'C005', obra_social: 'Sin cobertura' };
  const conCobertura = { id_cliente: 'C006', obra_social: 'PAMI' };
  assert.throws(() => validarMedioPago(sinCobertura, 'Obra social'), {
    code: 'MEDIO_PAGO_INVALIDO',
    details: { id_cliente: 'C005', medio_pago: 'Obra social' },
  });
  assert.doesNotThrow(() => validarMedioPago(conCobertura, 'Obra social'));
  for (const medio of ['Efectivo', 'Débito', 'Crédito', 'Transferencia']) {
    assert.doesNotThrow(() => validarMedioPago(sinCobertura, medio));
  }
});
