import { Kafka } from 'kafkajs';
import { config } from '../config.js';
import { logger } from '../logger.js';

let kafka;
let producer;

export function getKafka() {
  if (!kafka) {
    kafka = new Kafka({
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers,
      retry: { initialRetryTime: 300, retries: 8, maxRetryTime: 5_000 },
    });
  }
  return kafka;
}

export async function ensureTopic(topic = config.kafka.topic) {
  const admin = getKafka().admin();
  try {
    await admin.connect();
    await admin.createTopics({
      validateOnly: false,
      waitForLeaders: true,
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    });
    logger.info('kafka', `Tópico disponible: ${topic}`);
  } finally {
    await admin.disconnect();
  }
}

export async function getProducer() {
  if (!producer) {
    const instance = getKafka().producer({
      maxInFlightRequests: 5,
      idempotent: true,
      transactionTimeout: 30_000,
    });
    try {
      await instance.connect();
      producer = instance;
    } catch (error) {
      logger.error('kafka', 'No se pudo conectar el productor', error.message);
      throw error;
    }
  }
  return producer;
}

/** Publica un evento de navegación en user-navigation-events. */
export async function publishEvent(event) {
  const activeProducer = await getProducer();
  const recordMetadata = await activeProducer.send({
    topic: config.kafka.topic,
    messages: [{ key: event.user_id, value: JSON.stringify(event) }],
  });
  return recordMetadata;
}

export async function closeProducer() {
  if (producer) {
    await producer.disconnect();
    producer = undefined;
  }
}

export function createConsumer() {
  return getKafka().consumer({
    groupId: config.kafka.groupId,
    sessionTimeout: 30_000,
    rebalanceTimeout: 60_000,
    maxBytesPerPartition: 1_048_576,
    fromBeginning: true,
  });
}
