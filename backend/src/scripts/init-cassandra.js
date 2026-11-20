import cassandra from 'cassandra-driver';
import { config } from '../config.js';
import { logger } from '../logger.js';

const KEYSPACE = config.cassandra.keyspace;

/** Cada tabla responde a una consulta concreta de la aplicación. */
const TABLES = [
  // Catálogo: búsqueda por id de producto.
  `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.products (
    product_id text PRIMARY KEY,
    title text,
    category text,
    price double,
    description text,
    image text,
    rating double,
    brand text
  )`,

  // Catálogo paginado: una sola partición ordenada por product_id permite LIMIT/OFFSET barato.
  `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.products_by_catalog (
    catalog_key text,
    product_id text,
    title text,
    category text,
    price double,
    image text,
    rating double,
    PRIMARY KEY ((catalog_key), product_id)
  ) WITH CLUSTERING ORDER BY (product_id ASC)`,

  // Las 20 reseñas de un producto se leen con una única consulta por product_id.
  `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.product_reviews (
    product_id text,
    review_id text,
    user_id text,
    rating double,
    review_text text,
    profile_link text,
    PRIMARY KEY ((product_id), review_id)
  ) WITH CLUSTERING ORDER BY (review_id ASC)`,

  // Historial por usuario, más reciente primero.
  `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.user_sessions (
    user_id text,
    event_timestamp timestamp,
    product_id text,
    event_type text,
    PRIMARY KEY ((user_id), event_timestamp)
  ) WITH CLUSTERING ORDER BY (event_timestamp DESC)`,

  // Top-N precalculado por Spark: lectura secuencial por rank ascendente.
  `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.recommendations_spark (
    user_id text,
    rank int,
    product_id text,
    title text,
    category text,
    price double,
    score double,
    generated_at timestamp,
    PRIMARY KEY ((user_id), rank)
  ) WITH CLUSTERING ORDER BY (rank ASC)`,
];

async function main() {
  const admin = new cassandra.Client({
    contactPoints: config.cassandra.contactPoints,
    localDataCenter: config.cassandra.localDataCenter,
  });

  try {
    await admin.execute(`
      CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    `);
    logger.info('cassandra', `Keyspace ${KEYSPACE} creado/verificado`);

    for (const cql of TABLES) {
      await admin.execute(cql);
    }
    logger.info('cassandra', `${TABLES.length} tablas creadas/verificadas`);
  } finally {
    await admin.shutdown();
  }
}

main().catch((error) => {
  logger.error('cassandra', error.message);
  process.exitCode = 1;
});
