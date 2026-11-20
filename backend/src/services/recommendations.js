import { performance } from 'node:perf_hooks';
import neo4j from 'neo4j-driver';
import { config } from '../config.js';
import { execute } from '../db/cassandra.js';
import { readCypher } from '../db/neo4j.js';

const numberValue = (value, fallback = 0) => {
  if (value === null || value === undefined) return fallback;
  const result = typeof value.toNumber === 'function' ? value.toNumber() : Number(value);
  return Number.isFinite(result) ? result : fallback;
};

const toItem = (row) => ({
  rank: numberValue(row.rank, 0),
  product_id: row.product_id,
  title: row.title,
  category: row.category,
  price: numberValue(row.price),
  score: numberValue(row.score),
  generated_at: row.generated_at ? new Date(row.generated_at).toISOString() : null,
});

/** Consulta el Top-N precalculado por Spark en Cassandra. */
export async function sparkRecommendations(userId, limit = config.recommendationLimit) {
  const started = performance.now();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || config.recommendationLimit));

  const result = await execute(
    `SELECT rank, product_id, title, category, price, score, generated_at
     FROM ${config.cassandra.keyspace}.recommendations_spark
     WHERE user_id = ? LIMIT ${safeLimit}`,
    [userId],
  );

  return {
    engine: 'spark',
    userId,
    items: result.rows.map(toItem),
    latency_ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

/** Filtrado colaborativo en el grafo: usuarios vecinos → productos no vistos. */
export async function neo4jRecommendations(userId, limit = config.recommendationLimit) {
  const started = performance.now();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || config.recommendationLimit));

  const result = await readCypher(`
    MATCH (u:User {id: $userId})-->(seenProduct:Product)
    WITH u, collect(DISTINCT seenProduct.id) AS seen
    MATCH (u)-->(shared:Product)<--(other:User)
    WHERE other.id <> u.id
    WITH DISTINCT u, seen, other
    MATCH (other)-->(rec:Product)
    WHERE NOT rec.id IN seen
    RETURN rec.id AS product_id, rec.title AS title, rec.category AS category,
           rec.price AS price, count(DISTINCT other.id) AS score
    ORDER BY score DESC, product_id ASC
    LIMIT $limit
  `, { userId, limit: neo4j.int(safeLimit) });

  const items = result.records.map((record, index) => toItem({
    rank: index + 1,
    product_id: record.get('product_id'),
    title: record.get('title'),
    category: record.get('category'),
    price: record.get('price'),
    score: record.get('score'),
  }));

  return {
    engine: 'neo4j',
    userId,
    items,
    latency_ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

async function recentProducts(userId) {
  const result = await execute(
    `SELECT product_id FROM ${config.cassandra.keyspace}.user_sessions
     WHERE user_id = ? LIMIT 5`,
    [userId],
  );
  return result.rows.map((row) => row.product_id);
}

async function neighborCount(userId) {
  const result = await readCypher(`
    MATCH (u:User {id: $userId})-->(p:Product)<--(other:User)
    WHERE other.id <> u.id
    RETURN count(DISTINCT other.id) AS peers
  `, { userId });
  return result.records.length ? numberValue(result.records[0].get('peers')) : 0;
}

/** Ejecuta ambos motores y devuelve latencias + observaciones de calidad. */
export async function compareEngines(userId, limit = config.recommendationLimit) {
  const [sparkResult, graphResult, recentResult, peersResult] = await Promise.allSettled([
    sparkRecommendations(userId, limit),
    neo4jRecommendations(userId, limit),
    recentProducts(userId),
    neighborCount(userId),
  ]);

  const response = {
    userId,
    limit,
    generatedAt: new Date().toISOString(),
    spark: sparkResult.status === 'fulfilled'
      ? sparkResult.value
      : { engine: 'spark', userId, items: [], latency_ms: null, error: sparkResult.reason.message },
    neo4j: graphResult.status === 'fulfilled'
      ? graphResult.value
      : { engine: 'neo4j', userId, items: [], latency_ms: null, error: graphResult.reason.message },
  };

  const recent = recentResult.status === 'fulfilled' ? recentResult.value : [];
  const peers = peersResult.status === 'fulfilled' ? peersResult.value : 0;
  const overlap = (items) => items.filter((item) => recent.includes(item.product_id)).length;

  const sparkAge = response.spark.items[0]?.generated_at
    ? Date.now() - new Date(response.spark.items[0].generated_at).getTime()
    : null;

  response.quality = {
    spark: {
      coverage: Number((response.spark.items.length / limit).toFixed(2)),
      recentOverlap: overlap(response.spark.items),
      modelAgeHours: sparkAge === null ? null : Number((sparkAge / 3_600_000).toFixed(2)),
      notes: [
        'ALS captura patrones latentes de reseñas + sesiones, no solo vecinos directos.',
        sparkAge !== null && sparkAge > 86_400_000
          ? 'El modelo tiene más de 24 h: requiere re-entrenamiento.'
          : 'Modelo precalculado: latencia estable, pero no reacciona a clics hasta el próximo job.',
      ],
    },
    neo4j: {
      coverage: Number((response.neo4j.items.length / limit).toFixed(2)),
      neighborUsers: peers,
      recentOverlap: overlap(response.neo4j.items),
      notes: [
        'Cercanía en el grafo: recomienda productos de usuarios con interacciones comunes.',
        `${peers} usuarios vecinos detectados; los eventos Kafka actualizan el grafo al instante.`,
      ],
    },
  };

  const latencies = [response.spark.latency_ms, response.neo4j.latency_ms].filter((value) => value !== null);
  response.fasterEngine = latencies.length === 2
    ? (response.spark.latency_ms <= response.neo4j.latency_ms ? 'spark' : 'neo4j')
    : null;

  return response;
}
