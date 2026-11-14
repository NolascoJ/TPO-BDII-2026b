import { setTimeout } from 'node:timers/promises';
import { connectMongo, connectNeo4j } from '../src/db/connections.js';
import { config } from '../src/config.js';

const settings = config();
const deadline = Date.now() + settings.waitTimeoutMs;
while (true) {
  try {
    const { client, db } = await connectMongo(settings);
    try {
      const hello = await db.admin().command({ hello: 1 });
      if (!hello.isWritablePrimary || hello.setName !== 'rs0') {
        throw new Error('Replica set sin primario');
      }
    } finally {
      await client.close();
    }
    const driver = await connectNeo4j(settings);
    await driver.close();
    console.log('MongoDB primario y Neo4j disponibles.');
    break;
  } catch (error) {
    if (Date.now() >= deadline) {
      throw new Error(`Servicios no disponibles: ${error.message}`, { cause: error });
    }
    await setTimeout(1000);
  }
}
