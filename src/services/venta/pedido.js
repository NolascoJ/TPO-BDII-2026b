import { AppError } from '../../shared/errors.js';

export const MEDIOS_PAGO = ['Efectivo', 'Débito', 'Crédito', 'Transferencia', 'Obra social'];

// Precio, fecha, estado y total los decide el sistema: no se aceptan en el pedido
const CAMPOS_PEDIDO = new Set([
  'id_venta',
  'id_cliente',
  'id_farmaceutico',
  'id_receta',
  'medio_pago',
  'items',
]);
const CAMPOS_ITEM = new Set(['id_producto', 'cantidad']);

const esObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const esId = (valor) => typeof valor === 'string' && valor.trim().length > 0;

function parametrosInvalidos(mensaje, detalles = {}) {
  return new AppError('PARAMETROS_INVALIDOS', mensaje, detalles);
}

function itemsInvalidos(mensaje, detalles = {}) {
  return new AppError('ITEMS_INVALIDOS', mensaje, detalles);
}

function rechazarCamposExtra(objeto, permitidos, ubicacion) {
  const extra = Object.keys(objeto).filter((campo) => !permitidos.has(campo));
  if (extra.length) {
    throw parametrosInvalidos(`${ubicacion}: campo no permitido: ${extra.join(', ')}`, {
      campos: extra,
    });
  }
}

/**
 * Valida la forma del pedido de q14 y devuelve una copia normalizada.
 * No consulta la base: existencia y actividad de las entidades se validan después.
 * @param {object} pedido `{id_venta, id_cliente, id_farmaceutico, id_receta?, medio_pago, items}`.
 * @returns {{id_venta: string, id_cliente: string, id_farmaceutico: string,
 *   id_receta: string|null, medio_pago: string,
 *   items: {id_producto: string, cantidad: number}[]}}
 * @throws {AppError} `PARAMETROS_INVALIDOS` o `ITEMS_INVALIDOS`.
 */
export function validarPedido(pedido) {
  if (!esObjeto(pedido)) {
    throw parametrosInvalidos('El pedido debe ser un objeto');
  }
  rechazarCamposExtra(pedido, CAMPOS_PEDIDO, 'Pedido');

  for (const campo of ['id_venta', 'id_cliente', 'id_farmaceutico']) {
    if (!esId(pedido[campo])) {
      throw parametrosInvalidos(`Falta ${campo} o no es un string válido`, { campo });
    }
  }
  const idReceta = pedido.id_receta ?? null;
  if (idReceta !== null && !esId(idReceta)) {
    throw parametrosInvalidos('id_receta debe ser un string válido o nulo', {
      campo: 'id_receta',
    });
  }
  if (!MEDIOS_PAGO.includes(pedido.medio_pago)) {
    throw parametrosInvalidos('Medio de pago inválido', {
      medio_pago: pedido.medio_pago ?? null,
      permitidos: MEDIOS_PAGO,
    });
  }
  if (!Array.isArray(pedido.items) || pedido.items.length === 0) {
    throw itemsInvalidos('El pedido debe tener al menos un ítem');
  }

  const vistos = new Set();
  const items = pedido.items.map((item, indice) => {
    const ubicacion = `Ítem ${indice + 1}`;
    if (!esObjeto(item)) {
      throw itemsInvalidos(`${ubicacion}: debe ser un objeto`, { indice });
    }
    rechazarCamposExtra(item, CAMPOS_ITEM, ubicacion);
    if (!esId(item.id_producto)) {
      throw itemsInvalidos(`${ubicacion}: id_producto inválido`, { indice });
    }
    if (!Number.isSafeInteger(item.cantidad) || item.cantidad < 1) {
      throw itemsInvalidos(`${ubicacion}: la cantidad debe ser un entero positivo`, {
        indice,
        cantidad: item.cantidad ?? null,
      });
    }
    // Se rechaza en lugar de fusionar las cantidades
    if (vistos.has(item.id_producto)) {
      throw itemsInvalidos(`Producto repetido: ${item.id_producto}`, {
        id_producto: item.id_producto,
      });
    }
    vistos.add(item.id_producto);
    return { id_producto: item.id_producto, cantidad: item.cantidad };
  });

  return {
    id_venta: pedido.id_venta,
    id_cliente: pedido.id_cliente,
    id_farmaceutico: pedido.id_farmaceutico,
    id_receta: idReceta,
    medio_pago: pedido.medio_pago,
    items,
  };
}

/**
 * Arma los ítems de la venta con el precio vigente del catálogo y su id_detalle.
 * @param {string} idVenta
 * @param {{id_producto: string, cantidad: number}[]} items Ítems ya validados.
 * @param {object[]} productos Documentos de productos leídos en la transacción.
 * @returns {{id_detalle: string, id_producto: string, cantidad: number, precio_unit: number}[]}
 * @throws {AppError} `PRODUCTO_INVALIDO` si un producto no existe o está inactivo.
 */
export function construirItems(idVenta, items, productos) {
  const porId = new Map(productos.map((producto) => [producto.id_producto, producto]));
  return items.map((item, indice) => {
    const producto = porId.get(item.id_producto);
    if (!producto) {
      throw new AppError('PRODUCTO_INVALIDO', `Producto inexistente: ${item.id_producto}`, {
        id_producto: item.id_producto,
      });
    }
    if (producto.activo !== true) {
      throw new AppError('PRODUCTO_INVALIDO', `Producto inactivo: ${item.id_producto}`, {
        id_producto: item.id_producto,
      });
    }
    return {
      id_detalle: `${idVenta}-${String(indice + 1).padStart(2, '0')}`,
      id_producto: item.id_producto,
      cantidad: item.cantidad,
      precio_unit: producto.precio_unit,
    };
  });
}

/**
 * @param {{cantidad: number, precio_unit: number}[]} items
 * @returns {number}
 * @throws {AppError} `ITEMS_INVALIDOS` si el total excede los enteros seguros.
 */
export function calcularTotal(items) {
  const total = items.reduce((suma, item) => suma + item.cantidad * item.precio_unit, 0);
  if (!Number.isSafeInteger(total)) {
    throw itemsInvalidos('El total excede el rango de enteros seguros', { total });
  }
  return total;
}

/**
 * Campos en los que un pedido difiere de una venta ya registrada con el mismo id_venta.
 * Si la venta quedó como `Venta libre`, la receta del pedido se habría ignorado otra vez,
 * así que no cuenta como diferencia.
 * @param {object} venta Venta registrada.
 * @param {object} pedido Pedido validado con `validarPedido`.
 * @returns {string[]} Vacío si es el mismo pedido.
 */
export function diferenciasConVenta(venta, pedido) {
  const diferencias = ['id_cliente', 'id_farmaceutico', 'medio_pago'].filter(
    (campo) => venta[campo] !== pedido[campo],
  );
  const recetaEsperada = venta.tipo === 'Venta libre' ? null : pedido.id_receta;
  if (venta.id_receta !== recetaEsperada) {
    diferencias.push('id_receta');
  }
  const mismosItems =
    venta.items.length === pedido.items.length &&
    venta.items.every(
      (item, indice) =>
        item.id_producto === pedido.items[indice].id_producto &&
        item.cantidad === pedido.items[indice].cantidad,
    );
  if (!mismosItems) {
    diferencias.push('items');
  }
  return diferencias;
}

/**
 * Pagar con obra social requiere que el cliente tenga cobertura.
 * @param {{id_cliente: string, obra_social: string}} cliente
 * @param {string} medioPago
 * @throws {AppError} `MEDIO_PAGO_INVALIDO`.
 */
export function validarMedioPago(cliente, medioPago) {
  if (medioPago === 'Obra social' && cliente.obra_social === 'Sin cobertura') {
    throw new AppError('MEDIO_PAGO_INVALIDO', 'El cliente no tiene cobertura de obra social', {
      id_cliente: cliente.id_cliente,
      medio_pago: medioPago,
    });
  }
}
