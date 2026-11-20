import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { createEventStreamConsumer } from '../kafka/client.js';
import { logger } from '../logger.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let consumer;
let starting;
let ready = false;

function parseMessage(value) {
  if (!value) return null;
  try {
    const event = JSON.parse(value.toString());
    if (!event.user_id || !event.product_id || !event.event_type) return null;
    return event;
  } catch {
    return null;
  }
}

/** Fan-out único de Kafka hacia todas las conexiones SSE del proceso. */
export async function startEventStream() {
  if (ready && consumer) return;
  if (starting) return starting;

  starting = (async () => {
    const instance = createEventStreamConsumer();
    await instance.connect();
    await instance.subscribe({ topic: config.kafka.topic, fromBeginning: false });

    consumer = instance;
    ready = true;

    instance.run({
      autoCommit: true,
      eachMessage: async ({ topic, partition, message }) => {
        const event = parseMessage(message.value);
        if (!event) return;
        emitter.emit('event', {
          ...event,
          topic,
          partition,
          offset: message.offset,
          received_at: new Date().toISOString(),
        });
      },
    }).catch(async (error) => {
      logger.error('stream', `Consumidor SSE caído: ${error.message}`);
      if (consumer === instance) {
        consumer = undefined;
        ready = false;
      }
      await instance.disconnect().catch(() => {});
    });

    logger.info('stream', `Fan-out SSE activo en ${config.kafka.topic}`);
  })();

  try {
    await starting;
  } finally {
    starting = undefined;
  }
}

export function subscribeToEvents(listener) {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

export function isEventStreamReady() {
  return ready;
}

export async function stopEventStream() {
  const active = consumer;
  if (!active) return;
  consumer = undefined;
  ready = false;
  await active.disconnect().catch(() => {});
}
