import { mkdir, writeFile } from 'node:fs/promises';
import { generarAdicionales, aCSV } from '../src/data/additional.js';

const [fecha, ...extra] = process.argv.slice(2);
if (!fecha || extra.length) {
  throw new Error('Uso: npm run data:generate -- AAAA-MM-DD');
}
const datos = generarAdicionales(fecha);
const directorio = new URL('../data/adicionales/', import.meta.url);
await mkdir(directorio, { recursive: true });
for (const [nombre, filas] of Object.entries(datos)) {
  await writeFile(new URL(`${nombre}.csv`, directorio), aCSV(filas));
}
const resumen = {
  fecha_base: fecha,
  registros: Object.fromEntries(
    Object.entries(datos).map(([nombre, filas]) => [nombre, filas.length]),
  ),
};
await writeFile(new URL('manifest.json', directorio), JSON.stringify(resumen, null, 2) + '\n');
console.log(JSON.stringify(resumen, null, 2));
