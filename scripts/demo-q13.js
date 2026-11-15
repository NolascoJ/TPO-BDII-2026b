import assert from 'node:assert/strict';
import { q13 } from '../src/queries/q13.js';
import { conDemo, paso, sinId, mostrarDemo, campos, resumirCasos } from './lib/demo.js';

// ABM en MongoDB con eventos pendientes de sincronización.
await mostrarDemo(() =>
  conDemo({}, async (ctx) => {
    const { db } = ctx;
    const estado = async (id) => ({
      cliente: await db.collection('clientes').findOne({ id_cliente: id }, sinId),
      eventos: await db
        .collection('outbox')
        .find({ id_entidad: id }, sinId)
        .sort({ version: 1 })
        .toArray(),
      ventas: await db
        .collection('ventas')
        .find({ id_cliente: id }, sinId)
        .sort({ id_venta: 1 })
        .toArray(),
      recetas: await db
        .collection('recetas')
        .find({ id_cliente: id }, sinId)
        .sort({ id_receta: 1 })
        .toArray(),
    });
    const caso = (entrada, errorEsperado) =>
      paso({
        db,
        entrada,
        errorEsperado,
        estado: () => estado(entrada.id_cliente),
        operacion: () => q13(ctx, entrada),
      });
    const alta = {
      accion: 'alta',
      id_cliente: 'C-DEMO-Q13',
      datos: {
        nombre: 'Ana',
        apellido: 'Demostración',
        dni: '00999001',
        ciudad: 'Rosario',
        provincia: 'Santa Fe',
        obra_social: 'OSDE',
        nro_afiliado: 'OS-DEMO',
      },
    };
    const casos = {};
    casos.alta = await caso(alta);
    casos.dni_duplicado = await caso({ ...alta, id_cliente: 'C-DEMO-DUP' }, 'DNI_DUPLICADO');
    const modificar = {
      accion: 'modificar',
      id_cliente: alta.id_cliente,
      datos: { email: 'demo@example.test', obra_social: 'Sin cobertura' },
    };
    casos.modificacion = await caso(modificar);
    assert.equal(casos.modificacion.despues.cliente.nro_afiliado, null);
    casos.repeticion_modificacion = await caso(modificar);
    assert.equal(casos.repeticion_modificacion.mongo_sin_cambios, true);
    casos.baja_con_historial = await caso({ accion: 'baja', id_cliente: 'C006' });
    const baja = casos.baja_con_historial;
    assert.equal(baja.despues.cliente.activo, false);
    assert.deepEqual(baja.despues.ventas, baja.antes.ventas);
    assert.deepEqual(baja.despues.recetas, baja.antes.recetas);
    casos.repeticion_baja = await caso({ accion: 'baja', id_cliente: 'C006' });
    assert.equal(casos.repeticion_baja.mongo_sin_cambios, true);
    casos.reactivacion_rechazada = await caso(
      { accion: 'modificar', id_cliente: 'C006', datos: { activo: true } },
      'PARAMETROS_INVALIDOS',
    );
    return {
      formato_evidencia:
        'Campos del ABM, metadatos de eventos e IDs del historial; se verifican los documentos completos',
      casos: resumirCasos(casos, (estado) => ({
        cliente: campos(estado.cliente, [
          'id_cliente',
          'dni',
          'activo',
          'version',
          'email',
          'telefono',
          'obra_social',
          'nro_afiliado',
        ]),
        eventos: estado.eventos.map((e) => campos(e, ['id_evento', 'version', 'estado'])),
        ventas: estado.ventas.map((v) => v.id_venta),
        recetas: estado.recetas.map((r) => r.id_receta),
      })),
      verificaciones: {
        historial_conservado: true,
        repeticion_sin_eventos_nuevos: true,
        rechazos_sin_cambios: true,
      },
    };
  }),
);
