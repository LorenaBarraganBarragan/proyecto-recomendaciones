import neo4j from 'neo4j-driver';
import { config } from '../config.js';

let driver;

export function getNeo4jDriver() {
  if (!driver) {
    driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
      { maxConnectionPoolSize: 20, connectionAcquisitionTimeout: 15_000 },
    );
  }
  return driver;
}

async function run(mode, cypher, params = {}) {
  const session = getNeo4jDriver().session({ database: 'neo4j' });
  try {
    const executor = (tx) => tx.run(cypher, params);
    return await session[mode === 'read' ? 'executeRead' : 'executeWrite'](executor);
  } finally {
    await session.close();
  }
}

export const writeCypher = (cypher, params = {}) => run('write', cypher, params);
export const readCypher = (cypher, params = {}) => run('read', cypher, params);

export async function closeNeo4j() {
  if (driver) {
    await driver.close();
    driver = undefined;
  }
}
