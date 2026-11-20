import cassandra from 'cassandra-driver';
import neo4j from 'neo4j-driver';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getKafka } from '../kafka/client.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(name, fn, attempts = 60, delay = 2_000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fn();
      logger.info('wait', `${name}: listo`);
      return;
    } catch (error) {
      if (attempt === attempts) throw new Error(`${name} no respondió: ${error.message}`);
      logger.debug('wait', `${name}: esperando (${attempt}/${attempts})`);
      await sleep(delay);
    }
  }
}

async function waitCassandra() {
  const probe = new cassandra.Client({
    contactPoints: config.cassandra.contactPoints,
    localDataCenter: config.cassandra.localDataCenter,
  });
  try {
    await probe.execute('SELECT release_version FROM system.local', [], { timeout: 3_000 });
  } finally {
    await probe.shutdown();
  }
}

async function waitNeo4j() {
  const probe = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
  );
  try {
    await probe.verifyConnectivity();
  } finally {
    await probe.close();
  }
}

async function waitKafka() {
  const admin = getKafka().admin();
  try {
    await admin.connect();
    await admin.listTopics();
  } finally {
    await admin.disconnect();
  }
}

async function main() {
  await retry('Cassandra', waitCassandra);
  await retry('Neo4j', waitNeo4j);
  await retry('Kafka', waitKafka);
  logger.info('wait', 'Todos los servicios están disponibles');
}

main().catch((error) => {
  logger.error('wait', error.message);
  process.exitCode = 1;
});
