const BASE = import.meta.env.VITE_API_URL || '';

async function request(path, options = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

export const getMeta = () => request('/meta');

export function getProducts({ cursor, limit = 12, q = '' } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  if (q) query.set('q', q);
  return request(`/products?${query}`);
}

export const getReviews = (productId) => request(`/products/${encodeURIComponent(productId)}/reviews`);

export const postEvent = (event) => request('/events', {
  method: 'POST',
  body: JSON.stringify(event),
});

export function getRecommendations(userId, engine = 'spark-neighbors') {
  return request(`/recommendations/${encodeURIComponent(userId)}?engine=${engine}`);
}

export const getComparison = (userId) => request(`/compare/${encodeURIComponent(userId)}`);

/* Explorador persistido: nodos y aristas leídos solo de Neo4j. */
export const getNeo4jGraph = (userId, limit = 50) => request(
  `/graph/neo4j/${encodeURIComponent(userId)}?limit=${limit}`,
);

/** Eventos nuevos de Kafka entregados por Server-Sent Events. */
export function subscribeToEvents({ onEvent, onStatus } = {}) {
  const source = new EventSource(`${BASE}/api/stream/events`);

  source.addEventListener('status', (message) => {
    try { onStatus?.(JSON.parse(message.data)); } catch { /* status ignorado */ }
  });
  source.addEventListener('event', (message) => {
    try { onEvent?.(JSON.parse(message.data)); } catch { /* evento ignorado */ }
  });
  source.addEventListener('error', (message) => {
    try { onStatus?.({ status: 'error', ...JSON.parse(message.data) }); } catch { /* error ignorado */ }
  });
  source.onopen = () => onStatus?.({ status: 'connected' });
  source.onerror = () => onStatus?.({ status: 'reconnecting' });

  return () => source.close();
}

/* Demo en vivo: flujo, consultas, escala y nube. */
export const getDemoFlow = () => request('/demo/flow');
export const getDemoQueries = (userId) => request(`/demo/queries/${encodeURIComponent(userId)}`);
export const getDemoScale = (userId) => request(`/demo/scale/${encodeURIComponent(userId)}`);
export const getDemoCloud = () => request('/demo/cloud');
