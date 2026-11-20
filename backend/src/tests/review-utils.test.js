import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assignReviewsToProducts,
  buildReview,
  createReservoir,
  detectColumns,
  normalizeUserId,
  parseRating,
} from '../scripts/review-utils.js';

test('parseRating limpia el formato "Rated X out of 5 stars"', () => {
  assert.equal(parseRating('Rated 4 out of 5 stars'), 4);
  assert.equal(parseRating('Rated 3.5 out of 5 stars'), 3.5);
  assert.equal(parseRating('5'), 5);
  assert.equal(parseRating('Rated 0 out of 5 stars'), 0);
  assert.equal(parseRating('sin rating'), null);
  assert.equal(parseRating(''), null);
});

test('normalizeUserId usa el Profile Link de forma consistente', () => {
  const first = normalizeUserId('https://www.amazon.com/gp/profile/amzn1.account.ABC-123');
  const second = normalizeUserId('amzn1.account.ABC-123');
  assert.equal(first, second);
  assert.equal(first, 'u_amzn1.account.abc-123');
  assert.equal(normalizeUserId('@John Doe'), 'u_john-doe');
  assert.equal(normalizeUserId(null), null);
});

test('detectColumns reconoce cabeceras con espacios y alias', () => {
  const columns = detectColumns([
    'Review Id', 'Product Id', 'User Id', 'Rating', 'Review Text', 'Profile Link',
  ]);
  assert.deepEqual(columns, {
    rating: 3,
    profile: 5,
    user_id: 2,
    product_id: 1,
    review_id: 0,
    text: 4,
  });
});

test('buildReview prioriza Profile Link y valida rating', () => {
  const columns = detectColumns(['Review Id', 'Rating', 'Review Text', 'Profile Link']);
  const review = buildReview(['r1', 'Rated 2 out of 5 stars', 'Buen producto', 'https://x.com/p/jane'], columns, 1);
  assert.equal(review.user_id, 'u_jane');
  assert.equal(review.rating, 2);
  assert.equal(review.review_id, 'r1');
  assert.equal(buildReview(['r2', 'n/a', 'texto', ''], columns, 2), null);
});

test('el reservorio acota memoria y el reparto da reseñas distintas por producto', () => {
  let seed = 1;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const reservoir = createReservoir(50, rng);
  for (let i = 0; i < 1000; i += 1) reservoir.push({ review_id: `r${i}` });
  assert.equal(reservoir.size, 50);
  assert.equal(reservoir.seen, 1000);

  const result = assignReviewsToProducts(reservoir.items, ['1', '2'], 20, rng);
  assert.equal(result.get('1').length, 20);
  assert.equal(new Set(result.get('1').map((item) => item.review_id)).size, 20);
});
