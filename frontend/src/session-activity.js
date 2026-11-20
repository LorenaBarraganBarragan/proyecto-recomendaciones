export const interactionTypes = [
  { type: 'view', label: 'Vista', plural: 'Vistas', color: '#2563a5', dash: '3 5' },
  { type: 'click', label: 'Clic', plural: 'Clics', color: '#6d28d9', dash: '9 4' },
  { type: 'purchase', label: 'Compra', plural: 'Compras', color: '#087657' },
];

const zeroCounts = { view: 0, click: 0, purchase: 0 };

export const emptyActivity = {
  recent: [],
  counts: zeroCounts,
  products: new Map(),
  categories: new Map(),
};

export function recordInteraction(sessions, userId, entry) {
  const activity = sessions.get(userId) ?? emptyActivity;
  const previous = activity.products.get(entry.productId);
  const productCounts = previous?.counts ?? zeroCounts;
  const products = new Map(activity.products).set(entry.productId, {
    id: entry.productId,
    title: entry.title,
    category: entry.category,
    lastSequence: Math.max(entry.id, previous?.lastSequence ?? 0),
    counts: { ...productCounts, [entry.eventType]: productCounts[entry.eventType] + 1 },
  });
  const categories = new Map(activity.categories);
  if (entry.category) categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1);

  return new Map(sessions).set(userId, {
    products,
    categories,
    counts: { ...activity.counts, [entry.eventType]: activity.counts[entry.eventType] + 1 },
    recent: [...activity.recent, entry].sort((a, b) => b.id - a.id).slice(0, 10),
  });
}
