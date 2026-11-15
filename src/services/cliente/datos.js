import { AppError } from '../../shared/errors.js';
import { definitions } from '../../db/schema.js';

const contactoYCobertura = [
  'email',
  'telefono',
  'ciudad',
  'provincia',
  'obra_social',
  'nro_afiliado',
];
const camposAlta = ['nombre', 'apellido', 'dni', ...contactoYCobertura];
const coberturas = definitions.clientes.properties.obra_social.enum;
const esObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);

function invalido(mensaje, campo) {
  throw new AppError('PARAMETROS_INVALIDOS', mensaje, campo ? { campo } : {});
}

function soloCampos(objeto, permitidos) {
  const extra = Object.keys(objeto).filter((campo) => !permitidos.includes(campo));
  if (extra.length) {
    throw new AppError('PARAMETROS_INVALIDOS', `Campos no permitidos: ${extra.join(', ')}`, {
      campos: extra,
    });
  }
}

function texto(valor, campo) {
  if (typeof valor !== 'string' || valor.trim() === '') {
    invalido(`${campo} debe ser un string no vacío`, campo);
  }
  return valor.trim();
}

/**
 * Valida y copia los parámetros de q13. Recorta espacios exteriores sin convertir
 * DNI, teléfono ni identificadores a números. Los contactos vacíos se vuelven null.
 * El alta exige nombre, apellido, DNI, ciudad y provincia; por defecto no tiene cobertura.
 */
export function validarSolicitud(params) {
  if (!esObjeto(params)) {
    invalido('Se esperaba un objeto con accion e id_cliente');
  }
  if (!['alta', 'modificar', 'baja'].includes(params.accion)) {
    invalido('accion debe ser alta, modificar o baja', 'accion');
  }
  soloCampos(
    params,
    params.accion === 'baja' ? ['accion', 'id_cliente'] : ['accion', 'id_cliente', 'datos'],
  );
  const idCliente = texto(params.id_cliente, 'id_cliente');
  if (params.accion === 'baja') {
    return { accion: params.accion, id_cliente: idCliente };
  }
  if (!esObjeto(params.datos)) {
    invalido('datos debe ser un objeto', 'datos');
  }
  const alta = params.accion === 'alta';
  soloCampos(params.datos, alta ? camposAlta : contactoYCobertura);
  if (!alta && Object.keys(params.datos).length === 0) {
    invalido('La modificación debe indicar al menos un campo', 'datos');
  }
  const datos = { ...params.datos };
  for (const campo of alta
    ? ['nombre', 'apellido', 'dni', 'ciudad', 'provincia']
    : ['ciudad', 'provincia']) {
    if (alta || Object.hasOwn(datos, campo)) {
      datos[campo] = texto(datos[campo], campo);
    }
  }
  for (const campo of ['email', 'telefono', 'nro_afiliado']) {
    if (alta && !Object.hasOwn(datos, campo)) {
      datos[campo] = null;
    }
    if (Object.hasOwn(datos, campo) && datos[campo] !== null) {
      if (typeof datos[campo] !== 'string') {
        invalido(`${campo} debe ser un string o null`, campo);
      }
      datos[campo] = datos[campo].trim() || null;
    }
  }
  if (alta && !Object.hasOwn(datos, 'obra_social')) {
    datos.obra_social = 'Sin cobertura';
  }
  if (Object.hasOwn(datos, 'obra_social') && !coberturas.includes(datos.obra_social)) {
    invalido('Obra social no admitida', 'obra_social');
  }
  return { accion: params.accion, id_cliente: idCliente, datos };
}

/**
 * Devuelve los datos finales de contacto/cobertura sin modificar sus argumentos.
 * Sin cobertura implica afiliado null. Al cambiar de obra social, si no se indica
 * afiliado, se limpia el anterior para no asignar a la nueva cobertura un número ajeno.
 * Con cobertura se admite afiliado null.
 */
export function aplicarDatos(actual, datos) {
  const resultado = { ...actual, ...datos };
  if (
    resultado.obra_social === 'Sin cobertura' ||
    (Object.hasOwn(datos, 'obra_social') &&
      datos.obra_social !== actual.obra_social &&
      !Object.hasOwn(datos, 'nro_afiliado'))
  ) {
    resultado.nro_afiliado = null;
  }
  return resultado;
}
