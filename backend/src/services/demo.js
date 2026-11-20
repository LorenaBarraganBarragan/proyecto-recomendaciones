/**
 * Datos para el panel de demostración en vivo.
 *
 * Todo se consulta contra los servicios reales: no hay datos de relleno. Cada
 * bloque devuelve la consulta ejecutada, su resultado y una explicación para
 * que la evidencia sea visible y verificable desde la web.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config, dataDir } from '../config.js';
import { execute } from '../db/cassandra.js';
import { readCypher } from '../db/neo4j.js';
import { getTopicOffsets } from '../kafka/client.js';
import { compareEngines, sparkNeighborRecommendations } from './recommendations.js';

const KS = config.cassandra.keyspace;

/** Ejecuta una promesa y mide su latencia sin ocultar errores. */
async function timed(work) {
  const started = performance.now();
  try {
    const value = await work();
    return { ok: true, value, latency_ms: round(performance.now() - started) };
  } catch (error) {
    return { ok: false, error: error.message, latency_ms: round(performance.now() - started) };
  }
}

const round = (value) => Math.round(value * 100) / 100;
const iso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};
const timeShort = (value) => (value ? new Date(value).toLocaleTimeString('es-CO') : '—');

async function scalarCount(cql, params = []) {
  const result = await execute(cql, params);
  return result.rows.length ? Number(result.rows[0].count ?? 0) : 0;
}

function readIngestion() {
  const summaryPath = path.join(dataDir, 'ingestion-summary.json');
  if (!fs.existsSync(summaryPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ flujo */

/**
 * Estado de cada eslabón del pipeline y eventos recientes observados en los
 * almacenes. El frontend compara `revision` entre sondeos para resaltar por
 * dónde acaba de pasar un evento.
 */
export async function getDemoFlow() {
  const [kafkaProbe, sessionProbe, graphProbe, neighborsProbe, dbProbe] = await Promise.all([
    timed(() => getTopicOffsets()),
    timed(async () => {
      const [count, recent] = await Promise.all([
        scalarCount(`SELECT count(*) AS count FROM ${KS}.user_sessions`),
        execute(`SELECT user_id, product_id, event_type, event_timestamp
                 FROM ${KS}.user_sessions LIMIT 30`),
      ]);
      return { count, recent: recent.rows };
    }),
    timed(async () => {
      const [count, recent] = await Promise.all([
        readCypher('MATCH ()-[r]->() RETURN count(r) AS total').then(
          (result) => (result.records.length ? Number(result.records[0].get('total')) : 0),
        ),
        readCypher(`MATCH (u:User)-[r]->(p:Product)
                    WHERE r.timestamp IS NOT NULL
                    RETURN u.id AS user_id, p.id AS product_id,
                           type(r) AS event_type, r.timestamp AS timestamp
                    ORDER BY r.timestamp DESC LIMIT 8`),
      ]);
      return {
        count,
        recent: recent.records.map((record) => ({
          user_id: record.get('user_id'),
          product_id: record.get('product_id'),
          event_type: record.get('event_type'),
          timestamp: record.get('timestamp'),
        })),
      };
    }),
    timed(() => scalarCount(`SELECT count(*) AS count FROM ${KS}.recommendations_spark_neighbors`)),
    timed(() => execute('SELECT release_version FROM system.local')),
  ]);

  const kafkaMessages = kafkaProbe.ok
    ? kafkaProbe.value.reduce((sum, partition) => sum + Math.max(0, partition.high - partition.low), 0)
    : null;
  const sessions = sessionProbe.ok ? sessionProbe.value : { count: null, recent: [] };
  const graph = graphProbe.ok ? graphProbe.value : { count: null, recent: [] };
  // Cassandra solo ordena dentro de cada partición; el grafo sí permite ordenar
  // globalmente por timestamp, así que se usa como referencia del último evento.
  const lastSessionAt = graphProbe.ok
    ? graph.recent.map((row) => iso(row.timestamp)).filter(Boolean).sort().pop() ?? null
    : sessions.recent.map((row) => iso(row.event_timestamp)).filter(Boolean).sort().pop() ?? null;
  const neighborRows = neighborsProbe.ok ? neighborsProbe.value : null;

  const stage = (id, name, detail, probe, extra = {}) => ({
    id,
    name,
    detail,
    status: probe.ok ? 'ok' : 'error',
    latency_ms: probe.latency_ms,
    ...(probe.ok ? {} : { error: probe.error }),
    ...extra,
  });

  const stages = [
    stage('react', 'React / navegador', 'Clics en http://localhost:5173 publican eventos', { ok: true, latency_ms: 0 }, {
      kind: 'browser',
    }),
    stage('api', 'API Express', `POST /api/events → ${config.kafka.topic}`, dbProbe, { kind: 'api' }),
    stage('kafka', 'Kafka', kafkaMessages === null
      ? 'No se pudo consultar el offset'
      : `${kafkaMessages.toLocaleString('es-CO')} ${kafkaMessages === 1 ? 'mensaje' : 'mensajes'} en ${config.kafka.topic}`, kafkaProbe, {
      kind: 'kafka',
      messages: kafkaMessages,
    }),
    stage('consumer', 'Consumidor', sessions.count === null
      ? 'Sin acceso a la sesión'
      : `Último evento persistido: ${timeShort(lastSessionAt)}`, sessionProbe, {
      kind: 'consumer',
      lastEventAt: lastSessionAt,
    }),
    stage('cassandra', 'Cassandra', `${(sessions.count ?? 0).toLocaleString('es-CO')} eventos en user_sessions`, sessionProbe, {
      kind: 'store',
      count: sessions.count,
    }),
    stage('neo4j', 'Neo4j', `${(graph.count ?? 0).toLocaleString('es-CO')} relaciones en el grafo`, graphProbe, {
      kind: 'store',
      count: graph.count,
    }),
    stage('spark-neighbors', 'Spark vecinal', `${(neighborRows ?? 0).toLocaleString('es-CO')} recomendaciones por vecinos`, neighborsProbe, {
      kind: 'model',
      count: neighborRows,
    }),
  ];

  const byUser = new Map();
  for (const row of sessions.recent) {
    const key = `${row.user_id}|${row.product_id}|${row.event_type}`;
    byUser.set(key, {
      user_id: row.user_id,
      product_id: row.product_id,
      event_type: row.event_type,
      timestamp: iso(row.event_timestamp),
      stores: ['Cassandra'],
    });
  }
  for (const row of graph.recent) {
    const key = `${row.user_id}|${row.product_id}|${row.event_type}`;
    const existing = byUser.get(key);
    if (existing) {
      existing.stores.push('Neo4j');
    } else {
      byUser.set(key, {
        user_id: row.user_id,
        product_id: row.product_id,
        event_type: row.event_type,
        timestamp: iso(row.timestamp),
        stores: ['Neo4j'],
      });
    }
  }

  const recent = [...byUser.values()]
    .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
    .slice(0, 8);

  return {
    generatedAt: new Date().toISOString(),
    revision: [kafkaMessages, sessions.count, graph.count, neighborRows].join('|'),
    stages,
    recent,
    counters: {
      kafkaMessages,
      cassandraSessions: sessions.count,
      neo4jRelationships: graph.count,
      sparkNeighborRecommendations: neighborRows,
    },
  };
}

/* ---------------------------------------------------------------- consultas */

/** Consultas reales CQL, Cypher y Spark vecinal con su resultado y explicación. */
export async function getDemoQueries(userId) {
  const safeUser = String(userId ?? '').slice(0, 200).replace(/['\\]/g, '');
  const started = performance.now();

  const cqlRun = `SELECT user_id, event_timestamp, product_id, event_type
FROM ${KS}.user_sessions
WHERE user_id = ? LIMIT 5`;
  const cqlText = `SELECT user_id, event_timestamp, product_id, event_type
FROM ${KS}.user_sessions
WHERE user_id = '${safeUser}' LIMIT 5;`;
  const cypherText = `MATCH (u:User {id: '${safeUser}'})-[r]->(p:Product)
RETURN type(r) AS relation, p.id AS product_id, p.title AS title
LIMIT 10;`;
  const neighborsText = `SELECT product_id, score, neighbor_count, shared_products, example_neighbor
FROM ${KS}.recommendations_spark_neighbors
WHERE user_id = '${safeUser}' LIMIT 5;`;

  // Igual que allSettled, pero conservando el tiempo de cada consulta.
  const measure = async (work) => {
    const started = performance.now();
    try {
      return { status: 'fulfilled', value: await work(), latency_ms: round(performance.now() - started) };
    } catch (reason) {
      return { status: 'rejected', reason, latency_ms: round(performance.now() - started) };
    }
  };

  const [cql, cypher, neighbors] = await Promise.all([
    measure(() => execute(cqlRun.replace(/\s+/g, ' '), [safeUser]).then((result) => result.rows.map((row) => ({
      user_id: row.user_id,
      timestamp: iso(row.event_timestamp),
      product_id: row.product_id,
      event_type: row.event_type,
    })))),
    measure(() => readCypher(cypherText, { userId: safeUser }).then((result) => result.records.map((record) => ({
      relation: record.get('relation'),
      product_id: record.get('product_id'),
      title: record.get('title'),
    })))),
    measure(() => sparkNeighborRecommendations(safeUser, 5)),
  ]);

  const query = (id, engine, title, text, probe, explanation, rows) => ({
    id,
    engine,
    title,
    query: text,
    status: probe.status === 'fulfilled' ? 'ok' : 'error',
    rows: probe.status === 'fulfilled' ? rows(probe.value) : [],
    rowCount: probe.status === 'fulfilled' ? rows(probe.value).length : 0,
    error: probe.status === 'rejected' ? probe.reason.message : null,
    latency_ms: probe.latency_ms,
    explanation,
  });

  return {
    userId: safeUser,
    generatedAt: new Date().toISOString(),
    totalLatency_ms: round(performance.now() - started),
    queries: [
      query('cql', 'CQL', 'Sesión recién escrita (Cassandra)', cqlText, cql,
        'La clave de partición es user_id; event_timestamp es de clustering en orden descendente. Estas filas las escribió el consumidor al recibir el evento de Kafka.',
        (value) => value),
      query('cypher', 'Cypher', 'Relaciones del usuario (Neo4j)', cypherText, cypher,
        'MERGE creó el nodo :User y la relación CLICKED/VIEWED/PURCHASED cuando llegó el evento; el grafo se actualiza en vivo, sin reingesta.',
        (value) => value),
      query('neighbors', 'Spark', 'Recomendación por vecinos (Spark SQL)', neighborsText, neighbors,
        'Co-ocurrencia sobre reseñas y sesiones vigentes: dos usuarios son vecinos si interactuaron con los mismos productos del catálogo. Cada fila indica cuántos vecinos recomiendan el ítem y con cuántos productos compartidos. Si hay clics más recientes que el job, se recalcula en vivo.',
        (value) => value.items.map((item) => ({
          rank: item.rank,
          product_id: item.product_id,
          title: item.title,
          score: item.score,
          neighbor_count: item.neighbor_count,
          shared_products: item.shared_products,
          example_neighbor: item.example_neighbor,
          source: value.source,
        }))),
    ],
  };
}

/* ------------------------------------------------------------------- escala */

/** Volúmenes precargados, conteos en vivo y comparación de los dos motores. */
export async function getDemoScale(userId) {
  const [countsProbe, comparisonProbe] = await Promise.all([
    timed(async () => ({
      sessions: await scalarCount(`SELECT count(*) AS count FROM ${KS}.user_sessions`),
      reviews: await scalarCount(`SELECT count(*) AS count FROM ${KS}.product_reviews`),
      products: await scalarCount(`SELECT count(*) AS count FROM ${KS}.products_by_catalog`),
      sparkNeighbors: await scalarCount(`SELECT count(*) AS count FROM ${KS}.recommendations_spark_neighbors`),
    })),
    timed(() => compareEngines(userId, 5)),
  ]);

  const ingestion = readIngestion() ?? {};
  const reviews = ingestion.reviews ?? {};
  const counts = countsProbe.ok ? countsProbe.value : {};
  const comparison = comparisonProbe.ok ? comparisonProbe.value : null;

  return {
    generatedAt: new Date().toISOString(),
    preloaded: {
      rowsScanned: reviews.scanned ?? null,
      poolSize: reviews.pooled ?? null,
      reviewsAssigned: reviews.assigned ?? null,
      products: ingestion.catalog?.count ?? null,
      durationMs: ingestion.durationMs ?? null,
      source: ingestion.source ?? null,
      generatedAt: ingestion.generatedAt ?? null,
    },
    liveCounts: counts,
    comparison: comparison ? {
      sparkNeighbors: {
        items: comparison.sparkNeighbors.items.length,
        latency_ms: comparison.sparkNeighbors.latency_ms,
        source: comparison.sparkNeighbors.source ?? null,
        coverage: comparison.quality.sparkNeighbors.coverage,
        neighborUsers: comparison.quality.sparkNeighbors.neighborUsers,
      },
      neo4j: {
        items: comparison.neo4j.items.length,
        latency_ms: comparison.neo4j.latency_ms,
        coverage: comparison.quality.neo4j.coverage,
        neighborUsers: comparison.quality.neo4j.neighborUsers,
      },
      fasterEngine: comparison.fasterEngine,
      notes: [
        ...comparison.quality.sparkNeighbors.notes.map((text) => `[Spark vecinal] ${text}`),
        ...comparison.quality.neo4j.notes.map((text) => `[Grafo] ${text}`),
      ],
    } : { error: comparisonProbe.error },
    note: 'Los 500.000 registros se procesaron antes de la exposición desde la caché local; en vivo solo se publican eventos y se ejecutan consultas.',
  };
}

/* --------------------------------------------------------------------- nube */

function createS3Client() {
  const { aws } = config;
  const credentials = aws.accessKeyId && aws.secretAccessKey
    ? {
      accessKeyId: aws.accessKeyId,
      secretAccessKey: aws.secretAccessKey,
      ...(aws.sessionToken ? { sessionToken: aws.sessionToken } : {}),
    }
    : undefined;

  return new S3Client({
    region: aws.region,
    ...(aws.endpoint ? { endpoint: aws.endpoint } : {}),
    forcePathStyle: aws.forcePathStyle,
    ...(credentials ? { credentials } : {}),
  });
}

let cachedCloud;

/** HeadObject real contra S3: verifica acceso y muestra tamaño y fecha del objeto. */
export async function getDemoCloud() {
  if (cachedCloud && Date.now() - cachedCloud.checkedMillis < 30_000) {
    return { ...cachedCloud.data, cached: true };
  }

  const { bucket, csvKey, zipKey, region, profile } = config.aws;
  const key = csvKey || zipKey;
  const started = performance.now();
  let data;

  if (!bucket || !key) {
    data = {
      verified: false,
      bucket: bucket || null,
      key: null,
      region,
      profile: profile || 'default (credenciales por entorno)',
      error: 'S3_BUCKET o S3_REVIEWS_CSV_KEY no configurados',
      latency_ms: null,
    };
  } else {
    try {
      const response = await createS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      data = {
        verified: true,
        bucket,
        key,
        region,
        profile: profile || 'default (credenciales por entorno)',
        sizeBytes: response.ContentLength ?? null,
        lastModified: response.LastModified ? response.LastModified.toISOString() : null,
        contentType: response.ContentType ?? null,
        latency_ms: round(performance.now() - started),
        error: null,
      };
    } catch (error) {
      data = {
        verified: false,
        bucket,
        key,
        region,
        profile: profile || 'default (credenciales por entorno)',
        latency_ms: round(performance.now() - started),
        error: error.message,
      };
    }
  }

  data.checkedAt = new Date().toISOString();
  data.cached = false;
  cachedCloud = { data, checkedMillis: Date.now() };
  return data;
}
