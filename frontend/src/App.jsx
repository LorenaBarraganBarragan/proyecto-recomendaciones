import { useCallback, useEffect, useRef, useState } from 'react';
import { getMeta, getProducts, getReviews, postEvent, useMocks } from './api.js';
import ProductCatalog from './components/ProductCatalog.jsx';
import ProductDetail from './components/ProductDetail.jsx';
import RecommendationsPanel from './components/RecommendationsPanel.jsx';
import ComparisonPanel from './components/ComparisonPanel.jsx';
import InteractionHistory from './components/InteractionHistory.jsx';
import GraphExplorer from './components/GraphExplorer.jsx';
import { emptyActivity, recordInteraction } from './session-activity.js';

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
  const [sessions, setSessions] = useState(() => new Map());
  const eventSequence = useRef(0);
  const reviewRequest = useRef(0);

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

  const fireEvent = useCallback(async (product, eventType) => {
    if (!userId) return;
    const entry = {
      id: ++eventSequence.current,
      eventType,
      productId: product.id,
      title: product.title || product.id,
      category: product.category,
      timestamp: new Date().toISOString(),
    };
    try {
      await postEvent({ user_id: userId, product_id: product.id, event_type: eventType });
      setSessions((previous) => recordInteraction(previous, userId, entry));
      setToast(useMocks
        ? `Evento simulado ${eventType} registrado → ${product.id}`
        : `La API aceptó el evento ${eventType} → ${product.id}`);
      setRefreshKey((value) => value + 1);
    } catch (err) {
      setToast(`Error al publicar ${eventType}: ${err.message}`);
    }
  }, [userId]);

  const openProduct = useCallback(async (product) => {
    const requestId = ++reviewRequest.current;
    setSelected(product);
    setReviews([]);
    setReviewsLoading(true);
    void fireEvent(product, 'click');
    try {
      const data = await getReviews(product.id);
      if (requestId === reviewRequest.current) setReviews(data.items);
    } catch (err) {
      if (requestId === reviewRequest.current) setToast(`No se pudieron cargar reseñas: ${err.message}`);
    } finally {
      if (requestId === reviewRequest.current) setReviewsLoading(false);
    }
  }, [fireEvent]);

  const closeProduct = useCallback(() => {
    reviewRequest.current += 1;
    setSelected(null);
  }, []);

  const activity = sessions.get(userId) ?? emptyActivity;
  const interactionHistory = <InteractionHistory userId={userId} interactions={activity.recent} simulated={useMocks} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✦</span>
          <div>
            <h1>Motor de Recomendación Reactivo</h1>
            <p>{useMocks ? 'Spark ALS · Grafo Neo4j' : 'Kafka · Cassandra · Spark ALS · Neo4j'}</p>
          </div>
        </div>
        <label className="user-picker">
          <span>Usuario activo</span>
          <input
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="u_..."
            spellCheck="false"
            list={useMocks ? 'demo-users' : undefined}
          />
          {useMocks && (
            <datalist id="demo-users">
              {meta?.sampleUserIds.map((id) => <option key={id} value={id} />)}
            </datalist>
          )}
        </label>
      </header>

      <div className="subbar">
        <nav className="tabs">
          <button type="button" className={tab === 'catalog' ? 'active' : ''} aria-pressed={tab === 'catalog'} onClick={() => setTab('catalog')}>
            Catálogo y recomendaciones
          </button>
          <button type="button" className={tab === 'compare' ? 'active' : ''} aria-pressed={tab === 'compare'} onClick={() => setTab('compare')}>
            Comparativa Spark vs. Grafo
          </button>
          <button type="button" className={tab === 'graph' ? 'active' : ''} aria-pressed={tab === 'graph'} onClick={() => setTab('graph')}>
            Explorador de grafo
          </button>
        </nav>
        {meta?.ingestion && (
          <span className="muted meta-info">
            {meta.ingestion.catalogCount} productos · {meta.ingestion.reviewsAssigned} reseñas ·
            {useMocks ? ' catálogo de prueba' : ` ingesta ${new Date(meta.ingestion.generatedAt).toLocaleString()}`}
          </span>
        )}
      </div>

      {useMocks && <p className="demo-indicator">Modo demostración — datos simulados</p>}
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
            {interactionHistory}
          </aside>
        </div>
      ) : tab === 'compare' ? (
        <div className="comparison-view">
          <ComparisonPanel userId={userId} refreshKey={refreshKey} />
          {interactionHistory}
        </div>
      ) : (
        <main className="graph-explorer">
          <GraphExplorer userId={userId} activity={activity} simulated={useMocks} onBrowse={() => setTab('catalog')} />
          {interactionHistory}
        </main>
      )}

      {selected && (
        <ProductDetail
          product={selected}
          reviews={reviews}
          loading={reviewsLoading}
          onClose={closeProduct}
          onEvent={fireEvent}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
