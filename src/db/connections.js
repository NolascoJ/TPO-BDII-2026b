import { MongoClient } from 'mongodb';
import neo4j from 'neo4j-driver';
import { config } from '../config.js';

// Abrimos MongoDB. El código que use esta conexión tiene que cerrar client en un finally
export async function connectMongo(settings = config()) {
  const client = new MongoClient(settings.mongoUri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    return { client, db: client.db(settings.mongoDatabase) };
  } catch (error) {
    await client.close();
    throw error;
  }
}

// Crea el driver sin conectarse todavía. El procesador usa esta variante para registrar
// las fallas de conexión como intentos fallidos de cada evento. Quien llama debe cerrarlo.
export function crearDriverNeo4j(settings = config(), opciones = {}) {
  if (!settings.neo4jUri || !settings.neo4jUser || !settings.neo4jPassword) {
    throw new Error('Falta configuración de Neo4j');
  }
  return neo4j.driver(
    settings.neo4jUri,
    neo4j.auth.basic(settings.neo4jUser, settings.neo4jPassword),
    { connectionTimeout: 3000, ...opciones },
  );
}

// Abrimos Neo4j. Al terminar de usarlo hay que cerrar las sesiones y el driver
export async function connectNeo4j(settings = config()) {
  const driver = crearDriverNeo4j(settings);
  try {
    await driver.getServerInfo({ database: settings.neo4jDatabase });
    return driver;
  } catch (error) {
    await driver.close();
    throw error;
  }
}
