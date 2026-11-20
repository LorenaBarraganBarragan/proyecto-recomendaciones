import { readCypher } from '../db/neo4j.js';

const RELATION_BY_TYPE = {
  view: 'VIEWED',
  click: 'CLICKED',
  purchase: 'PURCHASED',
};

const numberValue = (value, fallback = 0) => {
  if (value === null || value === undefined) return fallback;
  const result = typeof value.toNumber === 'function' ? value.toNumber() : Number(value);
  return Number.isFinite(result) ? result : fallback;
};

function iso(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (typeof value.toNumber === 'function') return new Date(value.toNumber()).toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function relationType(entry) {
  const raw = String(entry?.eventType ?? entry?.relation ?? 'click').toLowerCase();
  return Object.hasOwn(RELATION_BY_TYPE, raw) ? raw : 'click';
}

const GRAPH_QUERY = `
  MATCH (u:User {id: $userId})-[r:VIEWED|CLICKED|PURCHASED]->(p:Product)
  WITH p, collect({
    relation: type(r),
    eventType: coalesce(r.event_type, toLower(type(r))),
    timestamp: r.timestamp
  }) AS interactions
  RETURN p.id AS productId,
         coalesce(p.title, p.id) AS title,
         coalesce(p.category, 'Sin categoría') AS category,
         interactions,
         interactions[0].timestamp AS lastTimestamp
  ORDER BY lastTimestamp DESC
  LIMIT toInteger($limit)
`;

const STATS_QUERY = `
  MATCH (u:User {id: $userId})
  OPTIONAL MATCH (u)-[r:VIEWED|CLICKED|PURCHASED]->(p:Product)
  RETURN count(DISTINCT p) AS products,
         count(r) AS relationships,
         count(CASE WHEN type(r) = 'VIEWED' THEN 1 END) AS views,
         count(CASE WHEN type(r) = 'CLICKED' THEN 1 END) AS clicks,
         count(CASE WHEN type(r) = 'PURCHASED' THEN 1 END) AS purchases,
         [category IN collect(DISTINCT p.category) WHERE category IS NOT NULL] AS categories
`;

/**
 * Grafo persistido: exclusivamente nodos, aristas y contadores leídos de Neo4j.
 * No mezcla la actividad local del navegador ni filas de Cassandra.
 */
export async function getNeo4jGraph(userId, limit = 50) {
  const [graphResult, statsResult] = await Promise.all([
    readCypher(GRAPH_QUERY, { userId, limit }),
    readCypher(STATS_QUERY, { userId }),
  ]);

  const nodes = [];
  const edges = [];

  for (const record of graphResult.records) {
    const productId = String(record.get('productId'));
    const title = String(record.get('title') ?? productId);
    const category = String(record.get('category') ?? 'Sin categoría');
    const interactions = record.get('interactions') ?? [];
    const counts = { view: 0, click: 0, purchase: 0 };

    interactions.forEach((entry, index) => {
      const type = relationType(entry);
      const timestamp = iso(entry.timestamp);
      counts[type] += 1;
      edges.push({
        id: `${userId}|${productId}|${type}|${index}`,
        source: userId,
        target: productId,
        type,
        relation: RELATION_BY_TYPE[type],
        timestamp,
        product_title: title,
      });
    });

    nodes.push({
      id: productId,
      kind: 'product',
      title,
      category,
      counts,
      total: interactions.length,
      lastTimestamp: iso(record.get('lastTimestamp')),
    });
  }

  const statsRecord = statsResult.records[0];
  const stats = statsRecord ? {
    products: numberValue(statsRecord.get('products')),
    relationships: numberValue(statsRecord.get('relationships')),
    views: numberValue(statsRecord.get('views')),
    clicks: numberValue(statsRecord.get('clicks')),
    purchases: numberValue(statsRecord.get('purchases')),
    categories: (statsRecord.get('categories') ?? []).map(String),
  } : {
    products: 0,
    relationships: 0,
    views: 0,
    clicks: 0,
    purchases: 0,
    categories: [],
  };

  const safeUser = String(userId ?? '').slice(0, 200).replace(/['\\]/g, '');
  return {
    userId: safeUser,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    stats,
    query: `MATCH (u:User {id: '${safeUser}'})-[r:VIEWED|CLICKED|PURCHASED]->(p:Product)\nRETURN p.id, p.title, p.category, type(r), r.timestamp\nORDER BY r.timestamp DESC\nLIMIT ${limit};`,
    source: 'Neo4j',
  };
}
