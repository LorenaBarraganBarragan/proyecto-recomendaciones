import { parse } from 'csv-parse/sync';

/** Normaliza texto para búsqueda: minúsculas y sin acentos. */
export function normalizeSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** "Rated 4 out of 5" → 4; "$2,499.99" → 2499.99. */
export function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}\b)/g, '');
  const normalized = cleaned.includes(',') && !cleaned.includes('.')
    ? cleaned.replace(',', '.')
    : cleaned;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstImage(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'null') return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return String(parsed[0] ?? '');
    if (parsed && typeof parsed === 'object') return String(parsed.url ?? parsed.src ?? '');
    return String(parsed ?? '');
  } catch {
    return raw.split(/[\s,]+/)[0] ?? '';
  }
}

function firstValue(row, keys, fallback = '') {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return fallback;
}

/** Convierte una fila del CSV público en el producto que espera Cassandra. */
export function normalizeProduct(row, index) {
  const title = firstValue(row, ['title', 'product_name', 'name'], `Producto ${index + 1}`);
  const productId = firstValue(row, ['product_id', 'asin', 'id'], `p_${index + 1}`);
  const description = firstValue(row, [
    'product_description',
    'description',
    'highlights',
    'features_summary',
  ]);

  return {
    product_id: productId,
    title,
    category: firstValue(row, ['root_category', 'category', 'categories', 'breadcrumbs'], 'general'),
    price: parseNumber(firstValue(row, ['final_price', 'initial_price', 'price'])) ?? 0,
    description: description.slice(0, 2000),
    image: firstImage(row.images ?? row.image ?? row.main_image),
    rating: parseNumber(row.rating) ?? 0,
    brand: firstValue(row, ['brand', 'manufacturer'], title.split(/[\s-]/)[0] || ''),
  };
}

/** Parsea el CSV de productos y devuelve hasta `limit` productos con id único. */
export function parseProductsCsv(text, limit = 1000) {
  const rows = parse(text, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const seen = new Set();
  const products = [];
  for (let index = 0; index < rows.length && products.length < limit; index += 1) {
    const product = normalizeProduct(rows[index], index);
    if (seen.has(product.product_id)) continue;
    seen.add(product.product_id);
    products.push(product);
  }
  return products;
}

/** Búsqueda de texto libre sobre título, categoría, marca y descripción. */
export function matchesProduct(product, query) {
  const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;

  const haystack = normalizeSearch([
    product.title,
    product.category,
    product.brand,
    product.description,
  ].join(' '));
  return tokens.every((token) => haystack.includes(token));
}
