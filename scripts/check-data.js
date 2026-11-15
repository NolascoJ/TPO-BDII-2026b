import { buildDataset } from '../src/data/prepare.js';

const data = await buildDataset({ adicionales: true });
console.log(
  JSON.stringify(
    {
      ok: true,
      colecciones: Object.fromEntries(
        Object.entries(data).map(([name, rows]) => [name, rows.length]),
      ),
      items_embebidos: data.ventas.reduce((sum, row) => sum + row.items.length, 0),
    },
    null,
    2,
  ),
);
