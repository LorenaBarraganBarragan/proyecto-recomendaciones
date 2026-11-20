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

export function getProducts({ cursor, limit = 12 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return request(`/products?${query}`);
}

export const getReviews = (productId) => request(`/products/${encodeURIComponent(productId)}/reviews`);

export const postEvent = (event) => request('/events', {
  method: 'POST',
  body: JSON.stringify(event),
});

export function getRecommendations(userId, engine = 'spark') {
  return request(`/recommendations/${encodeURIComponent(userId)}?engine=${engine}`);
}

export const getComparison = (userId) => request(`/compare/${encodeURIComponent(userId)}`);
