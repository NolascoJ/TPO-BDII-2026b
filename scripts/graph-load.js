import { connectMongo, connectNeo4j } from '../src/db/connections.js';
import { config } from '../src/config.js';
import { cargarGrafo } from '../src/graph/bootstrap.js';

// Uso: npm run graph:load            (carga o completa la proyección, idempotente)
//      npm run graph:load -- --reset (vacía el grafo y lo reconstruye desde MongoDB)
const args = process.argv.slice(2);
const desconocidos = args.filter((arg) => arg !== '--reset');
if (desconocidos.length > 0) {
  console.error(`Argumento no reconocido: ${desconocidos.join(' ')}. Uso: graph:load [-- --reset]`);
  process.exit(1);
}

const { client, db } = await connectMongo();
let driver;
try {
  driver = await connectNeo4j();
  const resultado = await cargarGrafo(
    { db, driver, neo4jDatabase: config().neo4jDatabase },
    { reset: args.includes('--reset') },
  );
  console.log(JSON.stringify(resultado, null, 2));
} finally {
  await driver?.close();
  await client.close();
}
