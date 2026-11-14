import { queries } from '../src/queries/registry.js';
import { connectMongo, connectNeo4j } from '../src/db/connections.js';
import { errorResult, AppError } from '../src/shared/errors.js';
import { config } from '../src/config.js';

const context = {};

try {
  const [id, json = '{}', ...rest] = process.argv.slice(2);
  if (!queries[id] || rest.length) {
    throw new AppError(
      'CONSULTA_INVALIDA',
      `Uso: npm run query -- <${Object.keys(queries).join('|')}> '[JSON]'`,
    );
  }
  const params = JSON.parse(json);
  if (params === null || Array.isArray(params) || typeof params !== 'object') {
    throw new AppError('PARAMETROS_INVALIDOS', 'Se esperaba un objeto JSON');
  }
  const query = queries[id];
  if (query.engines.includes('mongo')) {
    Object.assign(context, await connectMongo());
  }
  if (query.engines.includes('neo4j')) {
    context.driver = await connectNeo4j();
    context.neo4jDatabase = config().neo4jDatabase;
  }
  const data = await query.run(context, params);
  console.log(JSON.stringify({ ok: true, consulta: id, data }, null, 2));
} catch (error) {
  console.error(JSON.stringify(errorResult(error), null, 2));
  process.exitCode = 1;
} finally {
  await context.client?.close();
  await context.driver?.close();
}
