import { definitions } from '../db/schema.js';
import { buildDataset } from './prepare.js';

// Guardamos todo en una transacción y solo insertamos lo que falta
// Si repetimos la carga, el stock, las bajas y las dispensas quedan como estaban
export async function loadData(client, db, opciones = {}) {
  const data = await buildDataset(opciones);
  const session = client.startSession();

  try {
    return await session.withTransaction(
      async () => {
        const result = {};

        // Dentro de la misma transacción hacemos las operaciones una por una
        for (const [name, rows] of Object.entries(data)) {
          const idField = definitions[name].id;
          const operations = rows.map((row) => ({
            updateOne: {
              filter: { [idField]: row[idField] },
              update: { $setOnInsert: row },
              upsert: true,
            },
          }));

          const writeResult = await db.collection(name).bulkWrite(operations, { session });
          result[name] = {
            fuente: rows.length,
            insertados: writeResult.upsertedCount,
            existentes: writeResult.matchedCount,
          };
        }

        return { colecciones: result };
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
  } finally {
    await session.endSession();
  }
}
