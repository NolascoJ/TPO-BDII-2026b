import { connectMongo } from '../src/db/connections.js';
import { ensureSchema } from '../src/db/schema.js';
import { loadData } from '../src/data/load.js';

const { client, db } = await connectMongo();

try {
  await ensureSchema(db);
  console.log(JSON.stringify(await loadData(client, db, { adicionales: true }), null, 2));
} finally {
  await client.close();
}
