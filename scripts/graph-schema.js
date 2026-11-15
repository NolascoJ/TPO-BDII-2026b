import { connectNeo4j } from '../src/db/connections.js';
import { config } from '../src/config.js';
import { ensureGraphSchema } from '../src/graph/schema.js';

const driver = await connectNeo4j();

try {
  await ensureGraphSchema(driver, config().neo4jDatabase);
  console.log('Restricciones e índices del grafo preparados.');
} finally {
  await driver.close();
}
