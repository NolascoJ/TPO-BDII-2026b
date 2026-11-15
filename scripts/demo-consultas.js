import assert from 'node:assert/strict';
import { q06 } from '../src/queries/q06.js';
import { q07 } from '../src/queries/q07.js';
import { q09 } from '../src/queries/q09.js';
import { q11 } from '../src/queries/q11.js';
import { conDemo, snapshotMongo, mostrarDemo, campos } from './lib/demo.js';

// q06 y q11 usan la fecha actual; el resultado depende del día de ejecución.
await mostrarDemo(() =>
  conDemo({}, async ({ db }) => {
    const antes = await snapshotMongo(db);
    const consultas = {};
    const resumir = {
      q06: (r) => ({
        ...campos(r, ['id_receta', 'tipo', 'estado', 'proxima_dispensa']),
        cliente: campos(r.cliente, ['id_cliente', 'nombre', 'apellido']),
      }),
      q07: (r) => ({
        ...campos(r, ['id_producto', 'unidades_vendidas']),
        producto: r.producto?.nombre,
      }),
      q09: (v) => campos(v, ['id_venta', 'fecha', 'tipo', 'estado', 'total']),
      q11: (r) => ({
        ...campos(r, ['id_farmaceutico', 'ingresos_totales']),
        farmaceutico: campos(r.farmaceutico, ['nombre', 'apellido']),
      }),
    };
    for (const [nombre, ejecutar] of Object.entries({ q06, q07, q09, q11 })) {
      const resultado = await ejecutar({ db });
      consultas[nombre] = { cantidad: resultado.length, resultado: resultado.map(resumir[nombre]) };
    }
    const sinCambios = antes === (await snapshotMongo(db));
    assert.equal(sinCambios, true);
    return {
      consultas,
      mongo_sin_cambios: sinCambios,
      criterio_temporal:
        'Fecha real del sistema, con límites UTC; los CSV conservan sus fechas originales',
    };
  }),
);
