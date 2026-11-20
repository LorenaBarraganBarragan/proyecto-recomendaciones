import { products, reviewsByProduct, sampleUserIds, snapshotDate } from './mock-data.js';

const eventWeights = new Map([['view', 1], ['click', 2.5], ['purchase', 5]]);
const productsById = new Map(products.map((product) => [product.id, product]));
const eventsByUser = new Map();
const latencies = { spark: 4.2, neo4j: 8.7 };
const snapshotAgeHours = Math.max(0, Number(((Date.now() - Date.parse(snapshotDate)) / 3_600_000).toFixed(2)));

function parseLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, parsed)) : fallback;
}

function preferenceScore(product, userId) {
  const userIndex = sampleUserIds.indexOf(userId);
  const preferredCategory = ['papelería', 'audio', 'hogar', 'deportes'][userIndex];
  return product.rating + (product.category === preferredCategory ? 2 : 0);
}

function eventsFor(userId) {
  return eventsByUser.get(userId) ?? [];
}

function rankedItems(userId, engine) {
  const affinities = new Map();
  const purchased = new Set();
  if (engine === 'neo4j') {
    for (const event of eventsFor(userId)) {
      const { category } = productsById.get(event.product_id);
      affinities.set(category, (affinities.get(category) ?? 0) + eventWeights.get(event.event_type));
      if (event.event_type === 'purchase') purchased.add(event.product_id);
    }
  }

  return products.map((product) => ({
    product_id: product.id,
    title: product.title,
    category: product.category,
    price: product.price,
    score: preferenceScore(product, userId) + (affinities.get(product.category) ?? 0),
    generated_at: engine === 'spark' ? snapshotDate : null,
  })).sort((a, b) => Number(purchased.has(a.product_id)) - Number(purchased.has(b.product_id))
    || b.score - a.score || a.product_id.localeCompare(b.product_id))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

const sparkSnapshots = new Map(sampleUserIds.map((id) => [id, rankedItems(id, 'spark')]));
const defaultSparkSnapshot = rankedItems('', 'spark');

function recommend(userId, engine, limit) {
  const ranking = engine === 'spark'
    ? sparkSnapshots.get(userId) ?? defaultSparkSnapshot
    : rankedItems(userId, 'neo4j');
  const items = ranking.slice(0, limit).map((item) => ({ ...item }));
  return { engine, userId, items, latency_ms: latencies[engine] };
}

export const mockApi = {
  async getMeta() {
    return {
      sampleUserIds: [...sampleUserIds],
      ingestion: {
        generatedAt: snapshotDate,
        source: 'mock',
        catalogCount: products.length,
        reviewsAssigned: [...reviewsByProduct.values()].reduce((count, reviews) => count + reviews.length, 0),
      },
    };
  },

  async getProducts({ cursor, limit = 12 } = {}) {
    const pageSize = parseLimit(limit, 12, 100);
    const remaining = cursor ? products.filter((product) => product.id > cursor) : products;
    const items = remaining.slice(0, pageSize).map((product) => ({ ...product }));
    const hasMore = remaining.length > pageSize;
    return { items, limit: pageSize, nextCursor: hasMore ? items.at(-1).id : null, hasMore };
  },

  async getReviews(productId, limit = 20) {
    const id = String(productId);
    const items = (reviewsByProduct.get(id) ?? []).slice(0, parseLimit(limit, 20, 100));
    return { productId: id, items: items.map((review) => ({ ...review })) };
  },

  async postEvent(input) {
    const { user_id, product_id, event_type, timestamp } = input ?? {};
    const id = String(product_id);
    if (!user_id || !productsById.has(id) || !eventWeights.has(event_type)) {
      throw new Error('Se requieren un usuario, un producto del catálogo y un evento válido.');
    }

    const date = timestamp ? new Date(timestamp) : new Date();
    const event = {
      user_id: String(user_id),
      product_id: id,
      event_type,
      timestamp: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    };
    const history = eventsFor(event.user_id);
    history.push(event);
    eventsByUser.set(event.user_id, history);
    return { status: 'queued', topic: 'user-navigation-events', event: { ...event } };
  },

  async getRecommendations(userId, engine = 'spark', limit = 10) {
    const requested = String(engine).toLowerCase();
    const name = requested === 'grafo' ? 'neo4j' : requested;
    if (name !== 'spark' && name !== 'neo4j') throw new Error('engine debe ser spark o neo4j');
    return recommend(String(userId), name, parseLimit(limit, 10, 50));
  },

  async getComparison(userId, limit = 10) {
    const id = String(userId);
    const size = parseLimit(limit, 10, 50);
    const spark = recommend(id, 'spark', size);
    const neo4j = recommend(id, 'neo4j', size);
    const recent = new Set(eventsFor(id).slice(-5).map((event) => event.product_id));
    const metrics = ({ items }) => ({
      coverage: Number((items.length / size).toFixed(2)),
      recentOverlap: items.filter((item) => recent.has(item.product_id)).length,
    });

    return {
      userId: id,
      limit: size,
      generatedAt: new Date().toISOString(),
      spark,
      neo4j,
      quality: {
        spark: {
          ...metrics(spark),
          modelAgeHours: snapshotAgeHours,
          notes: ['La lista precalculada simulada permanece fija durante la sesión.'],
        },
        neo4j: {
          ...metrics(neo4j),
          neighborUsers: 0,
          notes: ['La afinidad por categoría se actualiza con vistas, clics y compras simuladas.'],
        },
      },
      fasterEngine: spark.latency_ms <= neo4j.latency_ms ? 'spark' : 'neo4j',
    };
  },
};
