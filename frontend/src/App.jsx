import { useCallback, useEffect, useState } from 'react';
import { getMeta, getProducts, getReviews, postEvent } from './api.js';
import ProductCatalog from './components/ProductCatalog.jsx';
import ProductDetail from './components/ProductDetail.jsx';
import RecommendationsPanel from './components/RecommendationsPanel.jsx';
import ComparisonPanel from './components/ComparisonPanel.jsx';

const EVENT_LABEL = { view: 'view', click: 'click', purchase: 'purchase' };

export default function App() {
  const [userId, setUserId] = useState('');
  const [meta, setMeta] = useState(null);
  const [products, setProducts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [tab, setTab] = useState('catalog');
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const loadProducts = useCallback(async (nextCursor = null, reset = false) => {
    setCatalogLoading(true);
    try {
      const data = await getProducts({ cursor: nextCursor, limit: 12 });
      setProducts((previous) => (reset ? data.items : [...previous, ...data.items]));
      setCursor(data.nextCursor);
      setHasMore(data.hasMore);
      setError('');
    } catch (err) {
      setError(`No se pudo cargar el catálogo: ${err.message}`);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => { loadProducts(null, true); }, [loadProducts]);

  useEffect(() => {
    getMeta()
      .then((data) => {
        setMeta(data);
        setUserId(data.sampleUserIds?.[0] || 'u_demo');
      })
      .catch(() => setUserId('u_demo'));
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const fireEvent = useCallback(async (productId, eventType) => {
    if (!userId) return;
    try {
      await postEvent({ user_id: userId, product_id: productId, event_type: eventType });
      setToast(`Evento ${EVENT_LABEL[eventType]} publicado en Kafka → ${productId}`);
      setRefreshKey((value) => value + 1);
    } catch (err) {
      setToast(`Error al publicar ${eventType}: ${err.message}`);
    }
  }, [userId]);

  const openProduct = useCallback(async (product) => {
    setSelected(product);
    setReviews([]);
    setReviewsLoading(true);
    try {
      const data = await getReviews(product.id);
      setReviews(data.items);
    } catch (err) {
      setToast(`No se pudieron cargar reseñas: ${err.message}`);
    } finally {
      setReviewsLoading(false);
    }
    await fireEvent(product.id, 'click');
  }, [fireEvent]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✦</span>
          <div>
            <h1>Motor de Recomendación Reactivo</h1>
            <p>Kafka · Cassandra · Spark ALS · Neo4j</p>
          </div>
        </div>
        <label className="user-picker">
          <span>Usuario activo</span>
          <input
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="u_..."
            spellCheck="false"
          />
        </label>
      </header>

      <div className="subbar">
        <nav className="tabs">
          <button type="button" className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>
            Catálogo y recomendaciones
          </button>
          <button type="button" className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}>
            Comparativa Spark vs. Grafo
          </button>
        </nav>
        {meta?.ingestion && (
          <span className="muted meta-info">
            {meta.ingestion.catalogCount} productos · {meta.ingestion.reviewsAssigned} reseñas ·
            ingesta {new Date(meta.ingestion.generatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {error && <div className="alert">{error}</div>}

      {tab === 'catalog' ? (
        <div className="layout">
          <main>
            <ProductCatalog
              products={products}
              hasMore={hasMore}
              loading={catalogLoading}
              onSelect={openProduct}
              onLoadMore={() => loadProducts(cursor)}
            />
          </main>
          <aside>
            <RecommendationsPanel userId={userId} refreshKey={refreshKey} />
            <section className="panel tips">
              <h3>Cómo probarlo</h3>
              <ol>
                <li>Haz clic en un producto: se publica <code>click</code> y se abre el detalle.</li>
                <li>Al abrir el detalle se envía <code>view</code>; el botón comprar envía <code>purchase</code>.</li>
                <li>El consumidor actualiza Cassandra y Neo4j; las recomendaciones se recargan solas.</li>
              </ol>
            </section>
          </aside>
        </div>
      ) : (
        <ComparisonPanel userId={userId} refreshKey={refreshKey} />
      )}

      {selected && (
        <ProductDetail
          product={selected}
          reviews={reviews}
          loading={reviewsLoading}
          onClose={() => setSelected(null)}
          onEvent={fireEvent}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
