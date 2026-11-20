import { config } from './config.js';
import { logger } from './logger.js';
import { closeCassandra, execute } from './db/cassandra.js';
import { closeNeo4j, writeCypher } from './db/neo4j.js';
import { createConsumer } from './kafka/client.js';

const EVENT_TO_REL = {
  view: 'VIEWED',
  click: 'CLICKED',
  purchase: 'PURCHASED',
};

/** Evita que dos eventos en el mismo milisegundo se sobrescriban en la clave de Cassandra. */
async function uniqueTimestamp(userId, incoming) {
  let millis = new Date(incoming).getTime();
  if (!Number.isFinite(millis)) millis = Date.now();

  const latest = await execute(
    `SELECT event_timestamp FROM ${config.cassandra.keyspace}.user_sessions
     WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  if (latest.rows.length) {
    const lastMillis = new Date(latest.rows[0].event_timestamp).getTime();
    if (millis <= lastMillis) millis = lastMillis + 1;
  }
  return new Date(millis);
}

async function persistSession(event, timestamp) {
  await execute(
    `INSERT INTO ${config.cassandra.keyspace}.user_sessions
      (user_id, event_timestamp, product_id, event_type) VALUES (?, ?, ?, ?)`,
    [event.user_id, timestamp, event.product_id, event.event_type],
  );
}

async function updateGraph(event, timestamp) {
  const relationship = EVENT_TO_REL[event.event_type];
  if (!relationship) return;

  // Whitelist estática: el tipo de relación nunca viene directamente del mensaje.
  await writeCypher(`
    MERGE (u:User {id: $userId})
    MERGE (p:Product {id: $productId})
      ON CREATE SET p.title = coalesce($productTitle, $productId),
                    p.category = coalesce($productCategory, 'unknown'),
                    p.price = 0.0
      ON MATCH SET p.title = coalesce($productTitle, p.title),
                   p.category = coalesce($productCategory, p.category)
    MERGE (u)-[r:${relationship}]->(p)
    SET r.event_type = $eventType, r.timestamp = $timestamp
  `, {
    userId: event.user_id,
    productId: event.product_id,
    productTitle: typeof event.product_title === 'string' ? event.product_title.slice(0, 200) : null,
    productCategory: typeof event.product_category === 'string' ? event.product_category.slice(0, 120) : null,
    eventType: event.event_type,
    timestamp: timestamp.toISOString(),
  });
}

async function handleMessage(payload) {
  if (!payload) return;
  let event;
  try {
    event = JSON.parse(payload.toString());
  } catch (error) {
    logger.warn('consumer', `Mensaje ignorado, JSON inválido: ${error.message}`);
    return;
  }
  if (!event.user_id || !event.product_id || !event.event_type) {
    logger.warn('consumer', 'Mensaje ignorado, campos obligatorios ausentes');
    return;
  }

  const timestamp = await uniqueTimestamp(event.user_id, event.timestamp);
  const [sessionResult, graphResult] = await Promise.allSettled([
    persistSession(event, timestamp),
    updateGraph(event, timestamp),
  ]);

  if (sessionResult.status === 'rejected') {
    logger.error('consumer', `Error escribiendo sesión: ${sessionResult.reason.message}`);
  }
  if (graphResult.status === 'rejected') {
    logger.error('consumer', `Error actualizando grafo: ${graphResult.reason.message}`);
  }
  if (sessionResult.status === 'fulfilled' && graphResult.status === 'fulfilled') {
    logger.info('consumer', `${event.event_type} ${event.user_id} → ${event.product_id}`);
  }
}

async function main() {
  const consumer = createConsumer();
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: true });
  logger.info('consumer', `Suscrito a ${config.kafka.topic} (grupo ${config.kafka.groupId})`);

  const shutdown = async () => {
    logger.info('consumer', 'Deteniendo consumidor...');
    await consumer.disconnect();
    await Promise.allSettled([closeCassandra(), closeNeo4j()]);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await consumer.run({
    eachMessage: async ({ message }) => handleMessage(message.value),
  });
}

main().catch((error) => {
  logger.error('consumer', error.stack ?? error.message);
  process.exitCode = 1;
});
