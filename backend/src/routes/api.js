import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, dataDir } from '../config.js';
import { execute } from '../db/cassandra.js';
import { publishEvent } from '../kafka/client.js';
import {
  compareEngines,
  neo4jRecommendations,
  sparkRecommendations,
} from '../services/recommendations.js';

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

apiRouter.get('/meta', asyncRoute(async (_req, res) => {
  const meta = readMeta();
  res.json({
    sampleUserIds: meta?.sampleUserIds ?? [],
    ingestion: meta ? {
      generatedAt: meta.generatedAt,
      source: meta.source,
      catalogCount: meta.catalog?.count,
      reviewsAssigned: meta.reviews?.assigned,
    } : null,
  });
}));

/** Catálogo paginado por cursor (clave de clustering de products_by_catalog). */
apiRouter.get('/products', asyncRoute(async (req, res) => {
  const limit = intParam(req.query.limit, 12, 1, 100);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const baseCql = `SELECT product_id, title, category, price, image, rating
    FROM ${config.cassandra.keyspace}.products_by_catalog WHERE catalog_key = ?`;
  const result = cursor
    ? await execute(`${baseCql} AND product_id > ? LIMIT ${limit}`, ['default', cursor])
    : await execute(`${baseCql} LIMIT ${limit}`, ['default']);

  const items = result.rows.map((row) => ({
    id: row.product_id,
    title: row.title,
    category: row.category,
    price: Number(row.price),
    image: row.image,
    rating: Number(row.rating),
  }));

  res.json({
    items,
    limit,
    nextCursor: items.length === limit ? items[items.length - 1].id : null,
    hasMore: items.length === limit,
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
  const { user_id: userId, product_id: productId, event_type: eventType, timestamp } = req.body ?? {};
  const validTypes = ['view', 'click', 'purchase'];

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
    user_id: String(userId),
    product_id: String(productId),
    event_type: eventType,
    timestamp: parsedTimestamp,
  };
  await publishEvent(event);

  res.status(202).json({ status: 'queued', topic: config.kafka.topic, event });
}));

apiRouter.get('/recommendations/:userId', asyncRoute(async (req, res) => {
  const limit = intParam(req.query.limit, config.recommendationLimit, 1, 50);
  const engine = String(req.query.engine ?? 'spark').toLowerCase();

  if (engine === 'spark') return res.json(await sparkRecommendations(req.params.userId, limit));
  if (engine === 'neo4j' || engine === 'grafo') return res.json(await neo4jRecommendations(req.params.userId, limit));
  return res.status(400).json({ error: 'engine debe ser spark o neo4j' });
}));

apiRouter.get('/compare/:userId', asyncRoute(async (req, res) => {
  const limit = intParam(req.query.limit, config.recommendationLimit, 1, 50);
  res.json(await compareEngines(req.params.userId, limit));
}));

export function errorHandler(error, _req, res, _next) {
  console.error('[api] Error no manejado:', error);
  res.status(500).json({ error: error.message ?? 'Error interno' });
}
