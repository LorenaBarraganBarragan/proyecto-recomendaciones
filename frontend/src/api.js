export const useMocks = import.meta.env?.VITE_USE_MOCKS === 'true';
const BASE = import.meta.env?.VITE_API_URL || '';
const mocks = useMocks ? import('./mock-api.js').then(({ mockApi }) => mockApi) : null;

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

export const getMeta = () => mocks ? mocks.then((api) => api.getMeta()) : request('/meta');

export function getProducts({ cursor, limit = 12 } = {}) {
  if (mocks) return mocks.then((api) => api.getProducts({ cursor, limit }));
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return request(`/products?${query}`);
}

export const getReviews = (productId) => mocks
  ? mocks.then((api) => api.getReviews(productId))
  : request(`/products/${encodeURIComponent(productId)}/reviews`);

export const postEvent = (event) => mocks ? mocks.then((api) => api.postEvent(event)) : request('/events', {
  method: 'POST',
  body: JSON.stringify(event),
});

export function getRecommendations(userId, engine = 'spark') {
  if (mocks) return mocks.then((api) => api.getRecommendations(userId, engine));
  return request(`/recommendations/${encodeURIComponent(userId)}?engine=${engine}`);
}

export const getComparison = (userId) => mocks
  ? mocks.then((api) => api.getComparison(userId))
  : request(`/compare/${encodeURIComponent(userId)}`);
