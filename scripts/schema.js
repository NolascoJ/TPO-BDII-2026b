import { connectMongo } from '../src/db/connections.js';
import { ensureSchema } from '../src/db/schema.js';

const { client, db } = await connectMongo();

try {
  await ensureSchema(db);
  console.log('Esquema e índices preparados.');
} finally {
  await client.close();
}
