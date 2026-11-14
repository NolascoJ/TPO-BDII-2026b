// Leemos la configuración del entorno para no dejar credenciales en el código
export function config(env = process.env) {
  const required = (name) => {
    if (!env[name]) {
      throw new Error(`Falta la variable ${name}`);
    }
    return env[name];
  };
  return {
    mongoUri: required('MONGODB_URI'),
    mongoDatabase: required('MONGODB_DATABASE'),
    neo4jUri: env.NEO4J_URI,
    neo4jDatabase: env.NEO4J_DATABASE ?? 'neo4j',
    neo4jUser: env.NEO4J_USER,
    neo4jPassword: env.NEO4J_PASSWORD,
    waitTimeoutMs: Number(env.WAIT_TIMEOUT_MS ?? 120000),
  };
}
