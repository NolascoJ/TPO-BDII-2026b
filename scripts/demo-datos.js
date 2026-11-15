import { readFile } from 'node:fs/promises';
import { conDemo, mostrarDemo } from './lib/demo.js';
import { recorrerDatos } from './lib/recorrido-datos.js';

await mostrarDemo(() =>
  conDemo({ grafo: true, adicionales: true }, async (ctx) => ({
    fecha_base: JSON.parse(
      await readFile(new URL('../data/adicionales/manifest.json', import.meta.url), 'utf8'),
    ).fecha_base,
    ...(await recorrerDatos(ctx)),
  })),
);
