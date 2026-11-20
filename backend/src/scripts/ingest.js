import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config, dataDir } from '../config.js';
import { batch } from '../db/cassandra.js';
import { writeCypher, closeNeo4j } from '../db/neo4j.js';
import { logger } from '../logger.js';
import { closeCassandra } from '../db/cassandra.js';
import {
  assignReviewsToProducts,
  buildReview,
  createReservoir,
  detectColumns,
  generateSyntheticCsv,
  makeRng,
  streamCsv,
} from './review-utils.js';

const CATALOG_KEY = 'default';

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

async function downloadS3File(key, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await createS3Client().send(new GetObjectCommand({
    Bucket: config.aws.bucket,
    Key: key,
  }));
  await pipeline(response.Body, fs.createWriteStream(target));
  logger.info('ingest', `Descargado s3://${config.aws.bucket}/${key} → ${target}`);
  return target;
}

async function findCsvFromZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory && /\.csv$/i.test(entry.entryName));
  if (!entries.length) throw new Error('El .zip descargado no contiene ningún archivo .csv');

  entries.sort((a, b) => b.header.size - a.header.size);
  const target = path.join(dataDir, 'reviews-extracted.csv');
  fs.writeFileSync(target, entries[0].getData());
  logger.info('ingest', `CSV extraído: ${entries[0].entryName} → ${target}`);
  return target;
}

async function resolveReviewSource() {
  const configured = path.isAbsolute(config.reviews.csvPath)
    ? config.reviews.csvPath
    : path.resolve(config.projectRoot, config.reviews.csvPath);

  if (fs.existsSync(configured) && fs.statSync(configured).isFile()) {
    logger.info('ingest', `Usando CSV local: ${configured}`);
    return { filePath: configured, source: 'local' };
  }

  const { bucket, zipKey, csvKey } = config.aws;
  let s3Error = '';

  // El SDK resuelve credenciales por su cadena por defecto: variables de entorno,
  // ~/.aws/credentials (montado en el contenedor), AWS_PROFILE o roles de instancia.
  if (bucket && (csvKey || zipKey)) {
    try {
      if (csvKey) {
        const filePath = await downloadS3File(csvKey, path.join(dataDir, 'reviews.csv'));
        return { filePath, source: `s3://${bucket}/${csvKey}` };
      }
      const zipPath = await downloadS3File(zipKey, path.join(dataDir, 'reviews.zip'));
      const filePath = await findCsvFromZip(zipPath);
      return { filePath, source: `s3://${bucket}/${zipKey}` };
    } catch (error) {
      s3Error = error.message;
      logger.warn('ingest', `No se pudo descargar s3://${bucket}/${csvKey || zipKey}: ${s3Error}. Se buscan fuentes alternativas.`);
    }
  }

  if (config.reviews.allowSynthetic) {
    const filePath = path.join(dataDir, 'reviews-synthetic.csv');
    fs.mkdirSync(dataDir, { recursive: true });
    await generateSyntheticCsv(filePath, config.reviews.syntheticRows, config.reviews.seed);
    logger.warn('ingest', `Generado dataset sintético de ${config.reviews.syntheticRows} filas: ${filePath}`);
    return { filePath, source: 'synthetic' };
  }

  throw new Error(
    'No hay fuente de reseñas. Configura S3_BUCKET + S3_REVIEWS_CSV_KEY (o S3_REVIEWS_ZIP_KEY), ' +
    'un CSV local en REVIEWS_CSV_PATH o ALLOW_SYNTHETIC_REVIEWS=true.' +
    (s3Error ? ` Último error de S3: ${s3Error}` : ''),
  );
}

async function fetchProducts() {
  const url = new URL(config.products.apiUrl);
  url.searchParams.set('limit', String(config.products.apiLimit));
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`API de productos respondió ${response.status}`);

  const payload = await response.json();
  const products = Array.isArray(payload) ? payload : payload.products;
  if (!Array.isArray(products)) throw new Error('La API de productos no devolvió una lista');

  return products.slice(0, config.products.count).map((product) => ({
    product_id: String(product.id),
    title: String(product.title ?? 'Sin título'),
    category: String(product.category ?? 'general'),
    price: Number(product.price ?? 0),
    description: String(product.description ?? '').slice(0, 2000),
    image: String(product.thumbnail ?? product.images?.[0] ?? ''),
    rating: Number(product.rating ?? 0),
    brand: String(product.brand ?? ''),
  }));
}

async function persistProducts(products) {
  const statements = [];
  for (const product of products) {
    statements.push({
      query: `INSERT INTO ${config.cassandra.keyspace}.products
        (product_id, title, category, price, description, image, rating, brand)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [product.product_id, product.title, product.category, product.price,
        product.description, product.image, product.rating, product.brand],
    });
    statements.push({
      query: `INSERT INTO ${config.cassandra.keyspace}.products_by_catalog
        (catalog_key, product_id, title, category, price, image, rating)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [CATALOG_KEY, product.product_id, product.title, product.category,
        product.price, product.image, product.rating],
    });
  }

  for (let i = 0; i < statements.length; i += 100) {
    await batch(statements.slice(i, i + 100));
  }
  logger.info('ingest', `${products.length} productos persistidos en Cassandra`);
}

async function persistReviews(assignments) {
  let total = 0;
  for (const [productId, reviews] of assignments) {
    const statements = reviews.map((review) => ({
      query: `INSERT INTO ${config.cassandra.keyspace}.product_reviews
        (product_id, review_id, user_id, rating, review_text, profile_link)
        VALUES (?, ?, ?, ?, ?, ?)`,
      params: [productId, review.review_id, review.user_id, review.rating,
        review.review_text, review.profile_link],
    }));
    await batch(statements);
    total += reviews.length;
  }
  logger.info('ingest', `${total} reseñas persistidas en Cassandra`);
  return total;
}

async function persistGraph(products, assignments) {
  const productRows = products.map((p) => ({
    product_id: p.product_id,
    title: p.title,
    category: p.category,
    price: p.price,
  }));
  for (let i = 0; i < productRows.length; i += 200) {
    await writeCypher(`
      UNWIND $rows AS row
      MERGE (p:Product {id: row.product_id})
      SET p.title = row.title, p.category = row.category, p.price = row.price
    `, { rows: productRows.slice(i, i + 200) });
  }

  const reviewRows = [];
  for (const [productId, reviews] of assignments) {
    for (const review of reviews) {
      reviewRows.push({
        user_id: review.user_id,
        product_id: productId,
        review_key: `${productId}:${review.review_id}`,
        rating: review.rating,
        review_text: review.review_text,
      });
    }
  }

  for (let i = 0; i < reviewRows.length; i += 200) {
    await writeCypher(`
      UNWIND $rows AS row
      MERGE (u:User {id: row.user_id})
      MERGE (p:Product {id: row.product_id})
      MERGE (u)-[r:REVIEWED {review_key: row.review_key}]->(p)
      SET r.rating = row.rating, r.review_text = row.review_text
    `, { rows: reviewRows.slice(i, i + 200) });
  }
  logger.info('ingest', `Grafo inicial creado: ${products.length} productos, ${reviewRows.length} relaciones REVIEWED`);
  return reviewRows.length;
}

async function main() {
  const started = Date.now();
  const source = await resolveReviewSource();
  const products = await fetchProducts();
  const productIds = products.map((p) => p.product_id);
  const rng = makeRng(config.reviews.seed);
  const reservoir = createReservoir(config.reviews.poolSize, rng);

  let columns;
  let scanned = 0;
  await streamCsv(source.filePath, {
    onHeader: (header) => {
      columns = detectColumns(header, config.reviews.columns);
      if (columns.rating < 0) throw new Error(`No se encontró columna de rating en: ${header.join(', ')}`);
      logger.info('ingest', `Columnas detectadas: ${JSON.stringify(columns)}`);
    },
    onRow: async (row) => {
      scanned += 1;
      const review = buildReview(row, columns, scanned);
      if (review) reservoir.push(review);
      if (scanned % 100_000 === 0) {
        logger.info('ingest', `${scanned.toLocaleString()} filas leídas, pool=${reservoir.size}`);
      }
    },
  });

  const assignments = assignReviewsToProducts(reservoir.items, productIds, config.reviews.perProduct, rng);
  logger.info('ingest', `Reservorio: ${reservoir.size} reseñas de ${reservoir.seen.toLocaleString()} filas válidas`);

  await persistProducts(products);
  const assigned = await persistReviews(assignments);
  await persistGraph(products, assignments);

  const sampleUserIds = [...new Set(
    [...assignments.values()].flatMap((reviews) => reviews.map((review) => review.user_id)),
  )].slice(0, 10);

  const summary = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    source: source.source,
    catalog: { count: products.length, apiUrl: config.products.apiUrl },
    reviews: { scanned, pooled: reservoir.size, assigned, perProduct: config.reviews.perProduct },
    sampleUserIds,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'ingestion-summary.json'), JSON.stringify(summary, null, 2));
  logger.info('ingest', `Cruce completado en ${summary.durationMs} ms`, summary);
}

main()
  .catch((error) => {
    logger.error('ingest', error.stack ?? error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeCassandra(), closeNeo4j()]);
  });
