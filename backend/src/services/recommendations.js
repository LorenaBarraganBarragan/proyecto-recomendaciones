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

const EVENT_WEIGHTS = { view: 1, click: 2.5, purchase: 5 };

const dotProduct = (a, b) => {
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    total += Number(a[i]) * Number(b[i]);
  }
  return total;
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

/**
 * ALS online (fold-in): el job ya entrenó los factores de los productos. Con
 * los eventos del perfil nuevo construimos su vector latente en cada petición
 * (media ponderada por tipo de evento) y puntuamos el catálogo por producto
 * escalar. No requiere reentrenar, así que reacciona en tiempo real.
 */
async function alsOnlineRecommendations(userId, limit, events) {
  const started = performance.now();
  const result = await execute(
    `SELECT product_id, factors, title, category, price, generated_at
     FROM ${config.cassandra.keyspace}.als_item_factors`,
  );
  const items = result.rows.filter((row) => Array.isArray(row.factors) && row.factors.length);
  if (!items.length) return null;

  const vectors = new Map(items.map((row) => [String(row.product_id), row.factors.map(Number)]));
  const rank = vectors.values().next().value.length;
  const userVector = Array(rank).fill(0);
  const seen = new Set(events.map((event) => String(event.product_id)));
  let totalWeight = 0;

  for (const event of events) {
    const vector = vectors.get(String(event.product_id));
    if (!vector) continue;
    const weight = EVENT_WEIGHTS[event.event_type] ?? 1;
    for (let i = 0; i < rank; i += 1) userVector[i] += vector[i] * weight;
    totalWeight += weight;
  }

  // Sin eventos sobre productos del modelo no hay vector de usuario válido.
  if (!totalWeight) return null;
  for (let i = 0; i < rank; i += 1) userVector[i] /= totalWeight;

  const recommendations = items
    .filter((row) => !seen.has(String(row.product_id)))
    .map((row) => ({
      rank: 0,
      product_id: row.product_id,
      title: row.title,
      category: row.category,
      price: numberValue(row.price),
      score: Math.round(dotProduct(userVector, row.factors.map(Number)) * 1000) / 1000,
      generated_at: row.generated_at ? new Date(row.generated_at).toISOString() : null,
    }))
    .sort((a, b) => b.score - a.score
      || String(a.product_id).localeCompare(String(b.product_id)))
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  if (!recommendations.length) return null;

  return {
    engine: 'spark',
    userId,
    items: recommendations,
    source: 'als-online',
    note: `ALS en tiempo real: vector del perfil calculado desde ${events.length} eventos con los factores del modelo. Cambia al instante con cada clic.`,
    latency_ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

/**
 * Último recurso: arranque en frío por categorías exploradas y valoración,
 * usado solo si aún no hay factores ALS disponibles.
 */
async function coldStartRecommendations(userId, limit, seenProductIds) {
  const started = performance.now();
  const catalogResult = await execute(
    `SELECT product_id, title, category, price, rating
     FROM ${config.cassandra.keyspace}.products_by_catalog
     WHERE catalog_key = ? LIMIT ${Math.max(100, config.products.count)}`,
    ['default'],
  );
  const products = catalogResult.rows.map((row) => ({
    product_id: row.product_id,
    title: row.title,
    category: row.category,
    price: numberValue(row.price),
    rating: numberValue(row.rating),
  }));

  const byId = new Map(products.map((product) => [String(product.product_id), product]));
  const seen = new Set(seenProductIds.map(String));
  const preferred = new Set();

  for (const productId of seen) {
    const category = byId.get(productId)?.category;
    if (category) preferred.add(String(category).toLowerCase());
  }

  const items = products
    .filter((product) => !seen.has(String(product.product_id)))
    .map((product) => {
      const categoryMatch = product.category
        && preferred.has(String(product.category).toLowerCase());
      const score = numberValue(product.rating, 1)
        + (categoryMatch ? config.coldStart.categoryBoost : 0);
      return {
        product_id: product.product_id,
        title: product.title,
        category: product.category,
        price: product.price,
        score: Math.round(score * 1000) / 1000,
        categoryMatch,
      };
    })
    .sort((a, b) => b.score - a.score
      || String(a.product_id).localeCompare(String(b.product_id)))
    .slice(0, limit)
    .map((product, index) => ({
      rank: index + 1,
      product_id: product.product_id,
      title: product.title,
      category: product.category,
      price: product.price,
      score: product.score,
      generated_at: null,
    }));

  return {
    engine: 'spark',
    userId,
    items,
    source: 'cold-start',
    note: preferred.size
      ? `Arranque en frío: prioriza categorías exploradas (${[...preferred].join(', ')}). El job ALS aún no incluye este perfil.`
      : 'Arranque en frío: productos mejor valorados. Interactúa con productos o ejecuta ./scripts/run-spark.sh para personalizar con ALS.',
    latency_ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

/**
 * Consulta el Top-N precalculado por Spark. Si el perfil no está en el modelo,
 * calcula ALS online con sus eventos; si tampoco hay factores, usa cold-start.
 */
export async function sparkRecommendations(userId, limit = config.recommendationLimit) {
  const started = performance.now();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || config.recommendationLimit));

  const result = await execute(
    `SELECT rank, product_id, title, category, price, score, generated_at
     FROM ${config.cassandra.keyspace}.recommendations_spark
     WHERE user_id = ? LIMIT ${safeLimit}`,
    [userId],
  );

  const latency = () => Math.round((performance.now() - started) * 100) / 100;

  if (result.rows.length) {
    return {
      engine: 'spark',
      userId,
      items: result.rows.map(toItem),
      source: 'als',
      latency_ms: latency(),
    };
  }

  const events = config.alsOnline.enabled || config.coldStart.enabled
    ? await recentEvents(userId, 50)
    : [];

  if (config.alsOnline.enabled) {
    const online = await alsOnlineRecommendations(userId, safeLimit, events);
    if (online) {
      online.latency_ms = latency();
      return online;
    }
  }

  if (!config.coldStart.enabled) {
    return {
      engine: 'spark',
      userId,
      items: [],
      source: 'als',
      latency_ms: latency(),
    };
  }

  const fallback = await coldStartRecommendations(
    userId,
    safeLimit,
    events.map((event) => event.product_id),
  );
  fallback.latency_ms = latency();
  return fallback;
}

const toNeighborItem = (row) => ({
  rank: numberValue(row.rank, 0),
  product_id: row.product_id,
  title: row.title,
  category: row.category,
  price: numberValue(row.price),
  score: Number(numberValue(row.score).toFixed(3)),
  neighbor_count: numberValue(row.neighbor_count),
  shared_products: numberValue(row.shared_products),
  example_neighbor: row.example_neighbor,
  generated_at: row.generated_at ? new Date(row.generated_at).toISOString() : null,
});

/** Catálogo local para resolver título/categoría en el cálculo online. */
async function neighborCatalog() {
  const result = await execute(
    `SELECT product_id, title, category, price
     FROM ${config.cassandra.keyspace}.products_by_catalog
     WHERE catalog_key = 'default'`,
  );
  return new Map(result.rows.map((row) => [String(row.product_id), row]));
}

/**
 * Misma co-ocurrencia del job Spark, ejecutada en el backend sobre Cassandra.
 * Se usa para perfiles nuevos o cuando hay eventos más recientes que el job;
 * así el motor vecinal reacciona al instante, igual que el grafo.
 */
async function sparkNeighborsOnline(userId, limit) {
  const catalog = await neighborCatalog();
  const sessions = await execute(
    `SELECT user_id, product_id, event_type
     FROM ${config.cassandra.keyspace}.user_sessions LIMIT 5000`,
  );
  const byUser = new Map();
  for (const row of sessions.rows) {
    const user = String(row.user_id);
    const product = String(row.product_id);
    // Los eventos de catálogos anteriores no deben generar recomendaciones.
    if (!catalog.has(product)) continue;
    if (!byUser.has(user)) byUser.set(user, new Map());
    const products = byUser.get(user);
    const weight = EVENT_WEIGHTS[row.event_type] ?? 1;
    products.set(product, Math.max(products.get(product) ?? 0, weight));
  }

  const mine = byUser.get(String(userId));
  if (!mine?.size) return null;

  const scored = new Map();
  for (const [otherId, products] of byUser) {
    if (otherId === String(userId)) continue;
    let shared = 0;
    for (const productId of mine.keys()) {
      if (products.has(productId)) shared += 1;
    }
    if (!shared) continue;

    for (const [productId, weight] of products) {
      if (mine.has(productId)) continue;
      const entry = scored.get(productId) ?? {
        score: 0,
        neighbor_count: 0,
        shared_products: 0,
        example_neighbor: otherId,
      };
      entry.score += weight * shared;
      entry.neighbor_count += 1;
      entry.shared_products = Math.max(entry.shared_products, shared);
      if (String(otherId) < String(entry.example_neighbor)) entry.example_neighbor = String(otherId);
      scored.set(productId, entry);
    }
  }
  if (!scored.size) return null;

  const items = [...scored.entries()]
    .sort((a, b) => b[1].score - a[1].score
      || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([productId, entry], index) => {
      const product = catalog.get(productId);
      return {
        rank: index + 1,
        product_id: productId,
        title: product?.title ?? productId,
        category: product?.category ?? null,
        price: numberValue(product?.price),
        score: Number(entry.score.toFixed(3)),
        neighbor_count: entry.neighbor_count,
        shared_products: entry.shared_products,
        example_neighbor: entry.example_neighbor,
      };
    });

  return {
    engine: 'spark-neighbors',
    userId,
    items,
    source: 'spark-neighbors-online',
    note: `Spark vecinal en vivo: mismo algoritmo que el job Spark, recalculado sobre Cassandra. ${items[0]?.neighbor_count ?? 0} ${items[0]?.neighbor_count === 1 ? 'vecino' : 'vecinos'} con ${items[0]?.shared_products ?? 0} ${items[0]?.shared_products === 1 ? 'producto' : 'productos'} compartidos; reacciona a cada clic sin reentrenar.`,
  };
}

/**
 * Motor vecinal Spark: lee el Top-N del job y, si el perfil es nuevo o tiene
 * eventos más recientes que el job, recalcula la co-ocurrencia en vivo.
 */
export async function sparkNeighborRecommendations(userId, limit = config.recommendationLimit) {
  const started = performance.now();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || config.recommendationLimit));
  const latency = () => Math.round((performance.now() - started) * 100) / 100;

  const result = await execute(
    `SELECT rank, product_id, title, category, price, score, neighbor_count,
            shared_products, example_neighbor, generated_at
     FROM ${config.cassandra.keyspace}.recommendations_spark_neighbors
     WHERE user_id = ? LIMIT ${safeLimit}`,
    [userId],
  );

  const latest = await execute(
    `SELECT event_timestamp FROM ${config.cassandra.keyspace}.user_sessions
     WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  const latestMs = latest.rows[0] ? new Date(latest.rows[0].event_timestamp).getTime() : 0;
  const generatedMs = result.rows[0]?.generated_at
    ? new Date(result.rows[0].generated_at).getTime() : 0;
  const stale = latestMs > generatedMs;

  if (result.rows.length && !stale) {
    const first = result.rows[0];
    return {
      engine: 'spark-neighbors',
      userId,
      items: result.rows.map(toNeighborItem),
      source: 'spark-neighbors',
      note: `Spark vecinal: ${numberValue(first.neighbor_count)} ${numberValue(first.neighbor_count) === 1 ? 'usuario vecino' : 'usuarios vecinos'} con ${numberValue(first.shared_products)} ${numberValue(first.shared_products) === 1 ? 'producto' : 'productos'} en común. Recomendación explicable por vecindario, como en el grafo.`,
      latency_ms: latency(),
    };
  }

  const online = await sparkNeighborsOnline(userId, safeLimit);
  if (online) {
    online.latency_ms = latency();
    return online;
  }

  // Un clic reciente puede no tener vecinos todavía: en ese caso el Top-N del
  // job (calculado sobre todas las reseñas) es mejor que devolver una lista vacía.
  if (result.rows.length) {
    const first = result.rows[0];
    return {
      engine: 'spark-neighbors',
      userId,
      items: result.rows.map(toNeighborItem),
      source: 'spark-neighbors',
      note: `Spark vecinal: ${numberValue(first.neighbor_count)} ${numberValue(first.neighbor_count) === 1 ? 'usuario vecino' : 'usuarios vecinos'} con ${numberValue(first.shared_products)} ${numberValue(first.shared_products) === 1 ? 'producto' : 'productos'} en común. El recálculo en vivo no encontró vecinos para los últimos clics, así que se muestra el Top-N del job.`,
      latency_ms: latency(),
    };
  }

  return {
    engine: 'spark-neighbors',
    userId,
    items: [],
    source: 'spark-neighbors',
    latency_ms: latency(),
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

async function recentEvents(userId, limit = 50) {
  const result = await execute(
    `SELECT product_id, event_type FROM ${config.cassandra.keyspace}.user_sessions
     WHERE user_id = ? LIMIT ${Math.max(1, Math.min(50, Number(limit) || 50))}`,
    [userId],
  );
  return result.rows.map((row) => ({
    product_id: row.product_id,
    event_type: row.event_type,
  }));
}

async function recentProducts(userId, limit = 5) {
  const result = await execute(
    `SELECT product_id FROM ${config.cassandra.keyspace}.user_sessions
     WHERE user_id = ? LIMIT ${Math.max(1, Math.min(50, Number(limit) || 5))}`,
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

/** Ejecuta los dos motores visibles y devuelve latencias + observaciones de calidad. */
export async function compareEngines(userId, limit = config.recommendationLimit) {
  const [neighborsResult, graphResult, recentResult, peersResult] = await Promise.allSettled([
    sparkNeighborRecommendations(userId, limit),
    neo4jRecommendations(userId, limit),
    recentProducts(userId),
    neighborCount(userId),
  ]);

  const empty = (engine, result) => ({
    engine,
    userId,
    items: [],
    latency_ms: null,
    error: result.reason.message,
  });
  const response = {
    userId,
    limit,
    generatedAt: new Date().toISOString(),
    sparkNeighbors: neighborsResult.status === 'fulfilled'
      ? neighborsResult.value : empty('spark-neighbors', neighborsResult),
    neo4j: graphResult.status === 'fulfilled' ? graphResult.value : empty('neo4j', graphResult),
  };

  const recent = recentResult.status === 'fulfilled' ? recentResult.value : [];
  const peers = peersResult.status === 'fulfilled' ? peersResult.value : 0;
  const overlap = (items) => items.filter((item) => recent.includes(item.product_id)).length;

  response.quality = {
    sparkNeighbors: {
      coverage: Number((response.sparkNeighbors.items.length / limit).toFixed(2)),
      neighborUsers: response.sparkNeighbors.items[0]?.neighbor_count ?? 0,
      recentOverlap: overlap(response.sparkNeighbors.items),
      source: response.sparkNeighbors.source,
      notes: [
        'Spark vecinal: co-ocurrencia sobre reseñas y sesiones del catálogo vigente, la misma idea del grafo.',
        response.sparkNeighbors.source === 'spark-neighbors-online'
          ? 'Calculado en vivo: reacciona a los clics sin reentrenar ni reenviar el job.'
          : 'Top-N del job Spark; se recalcula en vivo si hay eventos más recientes que el job.',
        'Explicación por vecinos: cada ítem indica cuántos usuarios con productos compartidos lo recomiendan.',
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

  const latencies = [
    ['spark-neighbors', response.sparkNeighbors.latency_ms],
    ['neo4j', response.neo4j.latency_ms],
  ].filter(([, value]) => value !== null);
  response.fasterEngine = latencies.length
    ? latencies.sort((a, b) => a[1] - b[1])[0][0]
    : null;

  return response;
}
