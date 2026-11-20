import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, dataDir } from '../config.js';
import { execute } from '../db/cassandra.js';
import { publishEvent } from '../kafka/client.js';
import { getNeo4jGraph } from '../services/graph.js';
import {
  isEventStreamReady,
  startEventStream,
  subscribeToEvents,
} from '../services/event-stream.js';
import {
  compareEngines,
  neo4jRecommendations,
  sparkNeighborRecommendations,
  sparkRecommendations,
} from '../services/recommendations.js';
import {
  getDemoCloud,
  getDemoFlow,
  getDemoQueries,
  getDemoScale,
} from '../services/demo.js';
import { matchesProduct } from '../scripts/product-utils.js';

export const apiRouter = express.Router();

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const intParam = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

function readMeta() {
  const summaryPath = path.join(dataDir, 'ingestion-summary.json');
  if (!fs.existsSync(summaryPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    return null;
  }
}

apiRouter.get('/health', asyncRoute(async (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), topic: config.kafka.topic });
}));

/** Stream de eventos Kafka → SSE para el grafo en tiempo real del frontend. */
apiRouter.get('/stream/events', asyncRoute(async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  req.socket?.setTimeout?.(0);

  let closed = false;
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      cleanup();
    }
  };

  res.write('retry: 3000\n\n');
  send('status', {
    status: isEventStreamReady() ? 'connected' : 'starting',
    topic: config.kafka.topic,
  });

  const unsubscribe = subscribeToEvents((event) => send('event', event));
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n');
  }, 15_000);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  }

  req.on('close', cleanup);
  res.on('close', cleanup);

  try {
    await startEventStream();
    send('status', { status: 'connected', topic: config.kafka.topic });
  } catch (error) {
    send('error', { message: error.message });
  }
}));

apiRouter.get('/graph/neo4j/:userId', asyncRoute(async (req, res) => {
  const limit = intParam(req.query.limit, 50, 1, 200);
  res.json(await getNeo4jGraph(String(req.params.userId).slice(0, 200), limit));
}));

apiRouter.get('/meta', asyncRoute(async (_req, res) => {
  const meta = readMeta();
  res.json({
    sampleUserIds: meta?.sampleUserIds ?? [],
    ingestion: meta ? {
      generatedAt: meta.generatedAt,
      source: meta.source,
      catalogSource: meta.catalog?.source,
      catalogCount: meta.catalog?.count,
      reviewsScanned: meta.reviews?.scanned,
      reviewsPooled: meta.reviews?.pooled,
      reviewsAssigned: meta.reviews?.assigned,
      reviewsPerProduct: meta.reviews?.perProduct,
    } : null,
  });
}));

const productColumns = 'product_id, title, category, price, image, rating, description';
const toProduct = (row) => ({
  id: row.product_id,
  title: row.title,
  category: row.category,
  price: Number(row.price ?? 0),
  image: row.image,
  rating: Number(row.rating ?? 0),
  description: row.description,
});

/**
 * Catálogo paginado por cursor. Con `q` se filtran en memoria los 1.000
 * productos de la partición (Cassandra no soporta LIKE) y se pagina el resultado.
 */
apiRouter.get('/products', asyncRoute(async (req, res) => {
  const limit = intParam(req.query.limit, 12, 1, 100);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const baseCql = `SELECT ${productColumns}
    FROM ${config.cassandra.keyspace}.products_by_catalog WHERE catalog_key = ?`;

  if (query) {
    const result = await execute(baseCql, ['default']);
    const matches = result.rows
      .map(toProduct)
      .filter((product) => matchesProduct(product, query))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const remaining = cursor
      ? matches.filter((product) => String(product.id) > cursor)
      : matches;
    const items = remaining.slice(0, limit);
    const hasMore = remaining.length > items.length;

    return res.json({
      items,
      limit,
      nextCursor: hasMore ? items[items.length - 1].id : null,
      hasMore,
      total: matches.length,
      query,
    });
  }

  const result = cursor
    ? await execute(`${baseCql} AND product_id > ? LIMIT ${limit}`, ['default', cursor])
    : await execute(`${baseCql} LIMIT ${limit}`, ['default']);
  const items = result.rows.map(toProduct);

  return res.json({
    items,
    limit,
    nextCursor: items.length === limit ? items[items.length - 1].id : null,
    hasMore: items.length === limit,
    total: null,
    query: '',
  });
}));

/** Las 20 reseñas random asignadas a un producto. */
apiRouter.get('/products/:id/reviews', asyncRoute(async (req, res) => {
  const limit = intParam(req.query.limit, config.reviews.perProduct, 1, 100);
  const result = await execute(
    `SELECT review_id, user_id, rating, review_text, profile_link
     FROM ${config.cassandra.keyspace}.product_reviews
     WHERE product_id = ? LIMIT ${limit}`,
    [req.params.id],
  );

  res.json({
    productId: req.params.id,
    items: result.rows.map((row) => ({
      id: row.review_id,
      user_id: row.user_id,
      rating: Number(row.rating),
      text: row.review_text,
      profile_link: row.profile_link,
    })),
  });
}));

/** Captura de clics/view/purchase → Kafka. */
apiRouter.post('/events', asyncRoute(async (req, res) => {
  const {
    user_id: userId,
    product_id: productId,
    event_type: eventType,
    timestamp,
    product_title: productTitle,
    product_category: productCategory,
  } = req.body ?? {};
  const validTypes = ['view', 'click', 'purchase'];
  const cleanMeta = (value, max) => (
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
  );

  if (!userId || !productId || !validTypes.includes(eventType)) {
    return res.status(400).json({
      error: 'Se requieren user_id, product_id y event_type ∈ {view, click, purchase}',
    });
  }

  let parsedTimestamp = new Date().toISOString();
  if (timestamp && !Number.isNaN(new Date(timestamp).getTime())) {
    parsedTimestamp = new Date(timestamp).toISOString();
  }

  const event = {
    user_id: String(userId).slice(0, 200),
    product_id: String(productId).slice(0, 200),
    event_type: eventType,
    timestamp: parsedTimestamp,
  };
  const title = cleanMeta(productTitle, 200);
  const category = cleanMeta(productCategory, 120);
  if (title) event.product_title = title;
  if (category) event.product_category = category;
  await publishEvent(event);

  res.status(202).json({ status: 'queued', topic: config.kafka.topic, event });
}));

apiRouter.get('/recommendations/:userId', asyncRoute(async (req, res) => {
  const limit = intParam(req.query.limit, config.recommendationLimit, 1, 50);
  const engine = String(req.query.engine ?? 'spark').toLowerCase();

  if (engine === 'spark') return res.json(await sparkRecommendations(req.params.userId, limit));
  if (engine === 'spark-neighbors' || engine === 'vecinos') {
    return res.json(await sparkNeighborRecommendations(req.params.userId, limit));
  }
  if (engine === 'neo4j' || engine === 'grafo') return res.json(await neo4jRecommendations(req.params.userId, limit));
  return res.status(400).json({ error: 'engine debe ser spark, spark-neighbors o neo4j' });
}));

apiRouter.get('/compare/:userId', asyncRoute(async (req, res) => {
  const limit = intParam(req.query.limit, config.recommendationLimit, 1, 50);
  res.json(await compareEngines(req.params.userId, limit));
}));

/* --------------------------------------------- evidencia de la demo en vivo */

/** Flujo por los componentes: React → API → Kafka → consumidor → Cassandra + Neo4j. */
apiRouter.get('/demo/flow', asyncRoute(async (_req, res) => {
  res.json(await getDemoFlow());
}));

/** Consultas CQL / Cypher / Spark ejecutadas ahora, con resultado y explicación. */
apiRouter.get('/demo/queries/:userId', asyncRoute(async (req, res) => {
  res.json(await getDemoQueries(req.params.userId));
}));

/** Volúmenes precargados, conteos en vivo y comparación Spark vs Grafo. */
apiRouter.get('/demo/scale/:userId', asyncRoute(async (req, res) => {
  res.json(await getDemoScale(req.params.userId));
}));

/** HeadObject a S3 para acreditar que el servicio en la nube está accesible. */
apiRouter.get('/demo/cloud', asyncRoute(async (_req, res) => {
  res.json(await getDemoCloud());
}));

export function errorHandler(error, _req, res, _next) {
  console.error('[api] Error no manejado:', error);
  res.status(500).json({ error: error.message ?? 'Error interno' });
}
