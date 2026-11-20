import { useCallback, useEffect, useRef, useState } from 'react';
import { getMeta, getProducts, getReviews, postEvent } from './api.js';
import ProductCatalog from './components/ProductCatalog.jsx';
import ProductDetail from './components/ProductDetail.jsx';
import RecommendationsPanel from './components/RecommendationsPanel.jsx';
import ComparisonPanel from './components/ComparisonPanel.jsx';
import DemoPanel from './components/DemoPanel.jsx';
import InteractionHistory from './components/InteractionHistory.jsx';
import GraphExplorer from './components/GraphExplorer.jsx';
import LiveGraph from './components/LiveGraph.jsx';
import { emptyActivity, recordInteraction } from './session-activity.js';

const EVENT_LABEL = { view: 'view', click: 'click', purchase: 'purchase' };

export default function App() {
  const [userId, setUserId] = useState('');
  const [meta, setMeta] = useState(null);
  const [products, setProducts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [catalogTotal, setCatalogTotal] = useState(null);
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
  const catalogRequest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const loadProducts = useCallback(async (nextCursor = null, reset = false, search = debouncedQuery) => {
    const requestId = ++catalogRequest.current;
    setCatalogLoading(true);
    try {
      const data = await getProducts({ cursor: nextCursor, limit: 12, q: search });
      if (requestId !== catalogRequest.current) return;
      setProducts((previous) => (reset ? data.items : [...previous, ...data.items]));
      setCursor(data.nextCursor);
      setHasMore(data.hasMore);
      setCatalogTotal(data.total ?? null);
      setError('');
    } catch (err) {
      if (requestId === catalogRequest.current) setError(`No se pudo cargar el catálogo: ${err.message}`);
    } finally {
      if (requestId === catalogRequest.current) setCatalogLoading(false);
    }
  }, [debouncedQuery]);

  useEffect(() => { loadProducts(null, true, debouncedQuery); }, [loadProducts, debouncedQuery]);

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

  // Acepta un producto completo (catálogo/detalle) o solo un id (demo en vivo).
  const fireEvent = useCallback(async (target, eventType) => {
    if (!userId) return;
    const product = typeof target === 'object' && target !== null
      ? target
      : { id: target, title: target, category: null };
    const productId = String(product.id);
    try {
      await postEvent({
        user_id: userId,
        product_id: productId,
        event_type: eventType,
        product_title: product.title || productId,
        product_category: product.category || undefined,
      });
      setSessions((previous) => recordInteraction(previous, userId, {
        id: ++eventSequence.current,
        eventType,
        productId,
        title: product.title || productId,
        category: product.category,
        timestamp: new Date().toISOString(),
      }));
      setToast(`Evento ${EVENT_LABEL[eventType]} publicado en Kafka → ${productId}`);
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
  const interactionHistory = <InteractionHistory userId={userId} interactions={activity.recent} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✦</span>
          <div>
            <h1>Motor de Recomendación Reactivo</h1>
            <p>Kafka · Cassandra · Spark vecinal · Neo4j</p>
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
          <button type="button" className={tab === 'catalog' ? 'active' : ''} aria-pressed={tab === 'catalog'} onClick={() => setTab('catalog')}>
            Catálogo y recomendaciones
          </button>
          <button type="button" className={tab === 'compare' ? 'active' : ''} aria-pressed={tab === 'compare'} onClick={() => setTab('compare')}>
            Comparativa de motores
          </button>
          <button type="button" className={tab === 'graph' ? 'active' : ''} aria-pressed={tab === 'graph'} onClick={() => setTab('graph')}>
            Explorador de grafo Neo4j
          </button>
          <button type="button" className={tab === 'live' ? 'active' : ''} aria-pressed={tab === 'live'} onClick={() => setTab('live')}>
            Grafo en tiempo real
          </button>
          <button type="button" className={tab === 'demo' ? 'active' : ''} aria-pressed={tab === 'demo'} onClick={() => setTab('demo')}>
            Demo en vivo
          </button>
        </nav>
        {meta?.ingestion && (
          <span className="muted meta-info">
            {meta.ingestion.catalogCount} productos · {meta.ingestion.reviewsPerProduct ?? '—'} reseñas c/u ·
            {' '}{meta.ingestion.reviewsAssigned} asignadas · ingesta {new Date(meta.ingestion.generatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {error && <div className="alert">{error}</div>}

      {tab === 'demo' ? (
        <DemoPanel userId={userId} refreshKey={refreshKey} onFireEvent={fireEvent} />
      ) : tab === 'catalog' ? (
        <div className="layout">
          <main>
            <ProductCatalog
              products={products}
              hasMore={hasMore}
              loading={catalogLoading}
              query={query}
              total={catalogTotal}
              onQueryChange={setQuery}
              onSelect={openProduct}
              onLoadMore={() => loadProducts(cursor, false, debouncedQuery)}
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
      ) : tab === 'live' ? (
        <main className="graph-explorer">
          <LiveGraph
            userId={userId}
            onFireEvent={fireEvent}
            onBrowse={() => setTab('catalog')}
          />
        </main>
      ) : (
        <main className="graph-explorer">
          <GraphExplorer
            userId={userId}
            refreshKey={refreshKey}
            onBrowse={() => setTab('catalog')}
          />
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
