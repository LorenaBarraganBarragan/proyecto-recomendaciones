import fs from 'node:fs';
import { parse } from 'csv-parse';

/** PRNG determinista para que la asignación de reseñas sea reproducible. */
export function makeRng(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "Rated 4 out of 5 stars" → 4; también acepta números sueltos. */
export function parseRating(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const labeled = raw.match(/rated\s*([0-5](?:[.,]\d+)?)\s*out\s*of\s*5\s*stars/i);
  const candidate = labeled ? labeled[1] : raw.match(/[0-5](?:[.,]\d+)?/)?.[0];
  if (!candidate) return null;

  const rating = Number.parseFloat(candidate.replace(',', '.'));
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) return null;
  return Math.round(rating * 10) / 10;
}

/** Extrae el último segmento de un Profile Link (o devuelve el identificador tal cual). */
export function extractProfileId(value) {
  if (!value) return null;
  const clean = String(value).trim().split(/[?#]/)[0].replace(/\/+$/, '');
  if (!clean) return null;
  try {
    const segment = clean.split('/').filter(Boolean).pop() ?? clean;
    return decodeURIComponent(segment);
  } catch {
    return clean.split('/').filter(Boolean).pop() ?? clean;
  }
}

/** Identificador estable y seguro para Cassandra, Spark y Neo4j. */
export function normalizeUserId(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(extractProfileId(value) ?? value)
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!normalized) return null;
  return `u_${normalized}`;
}

const normalizeName = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const NAME_ALIASES = {
  rating: ['rating', 'ratings', 'reviewrating', 'stars', 'star', 'reviewstars', 'ratingvalue', 'overallrating'],
  profile: ['profilelink', 'profile', 'userprofile', 'userprofilelink', 'reviewerprofile', 'reviewerprofilelink', 'profileurl', 'userurl', 'reviewerurl'],
  user_id: ['userid', 'user', 'reviewerid', 'customerid', 'username', 'reviewername', 'authorid', 'author'],
  product_id: ['productid', 'product', 'asin', 'itemid', 'producturl'],
  review_id: ['reviewid', 'reviewnumber', 'reviewkey', 'id', 'review'],
  text: ['reviewtext', 'reviewbody', 'reviewcontent', 'comment', 'content', 'description', 'body', 'text'],
};

/** Resuelve índices de columna por alias, con prioridad para los overrides del .env. */
export function detectColumns(header, overrides = {}) {
  const normalizedHeader = header.map(normalizeName);
  const columns = {};

  for (const [field, aliases] of Object.entries(NAME_ALIASES)) {
    const override = normalizeName(overrides[field]);
    const candidates = override ? [override, ...aliases] : aliases;
    let index = -1;

    for (const candidate of candidates) {
      const exact = normalizedHeader.indexOf(candidate);
      if (exact >= 0) {
        index = exact;
        break;
      }
    }
    if (index < 0 && !override) {
      index = normalizedHeader.findIndex((name) => name.length > 4 && aliases.some((alias) => name.includes(alias)));
    }
    columns[field] = index;
  }
  return columns;
}

/** Construye un review normalizado a partir de una fila del CSV. */
export function buildReview(row, columns, index) {
  const profileRaw = columns.profile >= 0 ? row[columns.profile] : null;
  const profileId = extractProfileId(profileRaw) ?? (columns.user_id >= 0 ? row[columns.user_id] : null);
  const rating = parseRating(columns.rating >= 0 ? row[columns.rating] : null);

  if (rating === null) return null;

  return {
    review_id: columns.review_id >= 0 && String(row[columns.review_id] ?? '').trim()
      ? String(row[columns.review_id]).trim()
      : `r_${index}`,
    user_id: normalizeUserId(profileId) ?? `u_anon_${index}`,
    rating,
    review_text: columns.text >= 0 ? String(row[columns.text] ?? '').slice(0, 4000) : '',
    profile_link: profileRaw ? String(profileRaw).slice(0, 500) : '',
  };
}

/** Muestreo de depósito: recorre el CSV una sola vez con memoria acotada. */
export function createReservoir(capacity, rng = Math.random) {
  const items = [];
  let seen = 0;

  return {
    push(item) {
      seen += 1;
      if (items.length < capacity) {
        items.push(item);
        return;
      }
      const slot = Math.floor(rng() * seen);
      if (slot < capacity) items[slot] = item;
    },
    get seen() { return seen; },
    get size() { return items.length; },
    get items() { return items; },
  };
}

/** Reparte `perProduct` reseñas distintas del pool a cada producto. */
export function assignReviewsToProducts(pool, productIds, perProduct, rng = Math.random) {
  const result = new Map(productIds.map((id) => [id, []]));
  if (!pool.length) return result;

  const take = Math.min(perProduct, pool.length);
  productIds.forEach((productId, productIndex) => {
    const offsets = [];
    for (let i = 0; i < take; i += 1) offsets.push(Math.floor(rng() * pool.length));
    const unique = [...new Set(offsets)];

    // Si el random colisionó demasiado, completamos con un barrido determinista.
    let cursor = (productIndex * 7) % pool.length;
    while (unique.length < take && unique.length < pool.length) {
      if (!unique.includes(cursor)) unique.push(cursor);
      cursor = (cursor + 1) % pool.length;
    }
    result.set(productId, unique.map((index) => pool[index]));
  });
  return result;
}

/** Itera un CSV por streaming; la primera fila se entrega como cabecera. */
export async function streamCsv(filePath, { onHeader, onRow }) {
  const parser = fs.createReadStream(filePath).pipe(parse({
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }));

  let header = null;
  for await (const record of parser) {
    if (!header) {
      header = record;
      if (onHeader) onHeader(header);
      continue;
    }
    await onRow(record);
  }
  return { header };
}

/** Dataset sintético pequeño para desarrollo cuando aún no hay S3 configurado. */
export async function generateSyntheticCsv(filePath, rows = 20000, seed = 42) {
  const rng = makeRng(seed);
  const categories = ['electronics', 'home', 'books', 'sports', 'fashion'];
  const stream = fs.createWriteStream(filePath);
  stream.write('review_id,product_id,user_id,rating,review_text,Profile Link\n');

  for (let i = 0; i < rows; i += 1) {
    const rating = 1 + Math.floor(rng() * 5);
    const line = [
      `syn-r-${i}`,
      `syn-p-${Math.floor(rng() * 100)}`,
      `syn-u-${Math.floor(rng() * Math.max(rows / 10, 10))}`,
      `Rated ${rating} out of 5 stars`,
      `Review sintética ${i} de categoría ${categories[i % categories.length]}`,
      `https://example.com/profiles/syn-u-${Math.floor(rng() * Math.max(rows / 10, 10))}`,
    ].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',');
    if (!stream.write(`${line}\n`)) {
      await new Promise((resolve) => stream.once('drain', resolve));
    }
  }

  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on('error', reject);
  });
  return rows;
}
