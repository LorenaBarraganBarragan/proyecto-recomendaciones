import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/** Carga el primer .env disponible sin sobrescribir variables ya inyectadas. */
function loadEnvFile() {
  const candidates = [
    process.env.ENV_FILE,
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate, override: false });
      return candidate;
    }
  }
  return null;
}

const envFile = loadEnvFile();

const str = (key, fallback = '') => (process.env[key] ?? fallback).trim();
const int = (key, fallback) => {
  const value = Number.parseInt(str(key, ''), 10);
  return Number.isFinite(value) ? value : fallback;
};
const float = (key, fallback) => {
  const value = Number.parseFloat(str(key, ''));
  return Number.isFinite(value) ? value : fallback;
};
const bool = (key, fallback = false) => {
  const value = str(key, '').toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value);
};
const list = (key, fallback) => {
  const value = str(key, '');
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : fallback;
};

// Los scripts pueden ejecutarse desde backend/ o desde la raíz del repositorio.
const projectRoot = path.basename(process.cwd()) === 'backend'
  ? path.resolve(process.cwd(), '..')
  : process.cwd();

export const config = Object.freeze({
  envFile,
  projectRoot,
  port: int('PORT', 4000),
  logLevel: str('LOG_LEVEL', 'info'),

  aws: {
    region: str('AWS_REGION', 'us-east-1'),
    bucket: str('S3_BUCKET'),
    zipKey: str('S3_REVIEWS_ZIP_KEY'),
    csvKey: str('S3_REVIEWS_CSV_KEY'),
    endpoint: str('S3_ENDPOINT'),
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
    accessKeyId: str('AWS_ACCESS_KEY_ID'),
    secretAccessKey: str('AWS_SECRET_ACCESS_KEY'),
    sessionToken: str('AWS_SESSION_TOKEN'),
    profile: str('AWS_PROFILE'),
  },

  reviews: {
    csvPath: str('REVIEWS_CSV_PATH', 'data/reviews.csv'),
    allowSynthetic: bool('ALLOW_SYNTHETIC_REVIEWS', false),
    syntheticRows: int('SYNTHETIC_REVIEW_ROWS', 20000),
    perProduct: int('REVIEWS_PER_PRODUCT', 50),
    poolSize: int('REVIEW_POOL_SIZE', 50000),
    chunkSize: int('INGEST_CHUNK_SIZE', 1000),
    seed: int('RANDOM_SEED', 42),
    columns: {
      review_id: str('REVIEWS_COL_REVIEW_ID'),
      product_id: str('REVIEWS_COL_PRODUCT_ID'),
      user_id: str('REVIEWS_COL_USER_ID'),
      rating: str('REVIEWS_COL_RATING'),
      text: str('REVIEWS_COL_TEXT'),
      profile: str('REVIEWS_COL_PROFILE'),
    },
  },

  products: {
    // Endpoint público con 1.000 productos de Best Buy (id, precio, imagen, etc.).
    dataUrl: str('PRODUCTS_DATA_URL', 'https://raw.githubusercontent.com/luminati-io/Best-Buy-dataset-sample/main/Best-Buy-dataset-sample.csv'),
    // Respaldo por si el CSV público no está disponible.
    apiUrl: str('PRODUCTS_API_URL', 'https://dummyjson.com/products'),
    apiLimit: int('PRODUCT_API_LIMIT', 0),
    count: int('PRODUCT_COUNT', 1000),
  },

  kafka: {
    brokers: list('KAFKA_BROKERS', ['kafka:29092']),
    topic: str('KAFKA_TOPIC', 'user-navigation-events'),
    clientId: str('KAFKA_CLIENT_ID', 'ecommerce-rec'),
    groupId: str('KAFKA_CONSUMER_GROUP', 'ecommerce-rec-consumer'),
  },

  cassandra: {
    contactPoints: list('CASSANDRA_CONTACT_POINTS', ['cassandra']),
    port: int('CASSANDRA_PORT', 9042),
    keyspace: str('CASSANDRA_KEYSPACE', 'ecommerce_rec'),
    localDataCenter: str('CASSANDRA_LOCAL_DATACENTER', 'datacenter1'),
  },

  neo4j: {
    uri: str('NEO4J_URI', 'bolt://neo4j:7687'),
    user: str('NEO4J_USER', 'neo4j'),
    password: str('NEO4J_PASSWORD', 'password123'),
  },

  recommendationLimit: int('RECOMMENDATION_LIMIT', 10),

  // Si el perfil no está en el modelo precalculado, se calcula su vector con
  // los factores ALS ya entrenados + sus eventos (fold-in online).
  alsOnline: {
    enabled: bool('ALS_ONLINE_ENABLED', true),
  },

  // Último recurso si todavía no hay factores ALS exportados.
  coldStart: {
    enabled: bool('COLD_START_ENABLED', true),
    categoryBoost: float('COLD_START_CATEGORY_BOOST', 2),
  },
});

export const dataDir = path.isAbsolute(config.reviews.csvPath)
  ? path.dirname(config.reviews.csvPath)
  : path.resolve(config.projectRoot, path.dirname(config.reviews.csvPath) || 'data');
