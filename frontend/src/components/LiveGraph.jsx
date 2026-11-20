import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeToEvents } from '../api.js';
import { interactionTypes } from '../session-activity.js';

const MAX_EVENTS = 100;
const EVENT_LABEL = { view: 'Vista', click: 'Clic', purchase: 'Compra' };
const TYPE_BY_EVENT = {
  view: interactionTypes[0],
  click: interactionTypes[1],
  purchase: interactionTypes[2],
};

const formatTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
};

const truncate = (value, max = 20) => (
  value.length > max ? `${value.slice(0, max - 1)}…` : value
);

function LiveNode({ label, children }) {
  return (
    <g>
      <title>{label}</title>
      {children}
    </g>
  );
}

function buildGraph(events) {
  const users = new Map();
  const products = new Map();
  const links = new Map();

  events.forEach((event) => {
    const user = event.user_id;
    const product = event.product_id;
    if (!user || !product) return;

    users.set(user, (users.get(user) ?? 0) + 1);
    products.set(product, (products.get(product) ?? 0) + 1);

    const key = `${user}|${product}|${event.event_type}`;
    const previous = links.get(key);
    links.set(key, {
      user,
      product,
      type: event.event_type,
      count: (previous?.count ?? 0) + 1,
      timestamp: event.timestamp,
    });
  });

  const topUsers = [...users.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([id, count]) => ({ id, count }));
  const topProducts = [...products.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 7)
    .map(([id, count]) => ({ id, count }));

  const userIndex = new Map(topUsers.map((node, index) => [node.id, index]));
  const productIndex = new Map(topProducts.map((node, index) => [node.id, index]));
  const edges = [...links.values()].filter((link) => (
    userIndex.has(link.user) && productIndex.has(link.product)
  ));

  return { users: topUsers, products: topProducts, edges, userIndex, productIndex };
}

function LiveSvg({ graph }) {
  const { users, products, edges, userIndex, productIndex } = graph;
  const rows = Math.max(users.length, products.length, 1);
  const height = Math.max(190, rows * 52 + 40);
  const position = (index, total) => (
    total <= 1 ? height / 2 : 36 + index * (height - 72) / (total - 1)
  );

  return (
    <svg className="session-graph live-graph-svg" viewBox={`0 0 720 ${height}`} role="group" aria-label="Grafo construido con eventos recibidos por SSE">
      {edges.map((link) => {
        const config = TYPE_BY_EVENT[link.type] ?? TYPE_BY_EVENT.click;
        const offset = (interactionTypes.indexOf(config) - 1) * 6;
        const uy = position(userIndex.get(link.user), users.length) + offset;
        const py = position(productIndex.get(link.product), products.length) + offset;
        return (
          <path
            key={`${link.user}|${link.product}|${link.type}`}
            fill="none"
            stroke={config.color}
            strokeDasharray={config.dash}
            strokeWidth={Math.min(4, 1.5 + link.count)}
            opacity={0.85}
            d={`M 128 ${uy} C 300 ${uy}, 380 ${py}, 505 ${py}`}
          >
            <title>{`${link.user} → ${link.product} · ${EVENT_LABEL[link.type] ?? link.type} ×${link.count}`}</title>
          </path>
        );
      })}
      {users.map((node, index) => {
        const y = position(index, users.length);
        return (
          <LiveNode key={node.id} label={`Usuario ${node.id} · ${node.count} eventos`}>
            <circle cx="72" cy={y} r="18" fill="#4540bb" stroke="white" strokeWidth="2" />
            <text x="72" y={y - 24} textAnchor="middle" fill="#374151" fontSize="11" fontWeight="650">
              {truncate(node.id)}
            </text>
            <text x="72" y={y + 4} textAnchor="middle" fill="white" fontSize="10" fontWeight="700">{node.count}</text>
          </LiveNode>
        );
      })}
      {products.map((node, index) => {
        const y = position(index, products.length);
        return (
          <LiveNode key={node.id} label={`Producto ${node.id} · ${node.count} eventos`}>
            <rect x="505" y={y - 17} width="185" height="34" rx="9" fill="white" stroke="#c6cde0" />
            <text x="515" y={y + 4} fill="#202943" fontSize="11" fontWeight="650">{truncate(node.id, 25)}</text>
            <circle cx="676" cy={y} r="10" fill="#eef2ff" />
            <text x="676" y={y + 3.5} textAnchor="middle" fill="#4540bb" fontSize="9" fontWeight="700">{node.count}</text>
          </LiveNode>
        );
      })}
    </svg>
  );
}

export default function LiveGraph({ userId, onFireEvent, onBrowse }) {
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState({ status: 'connecting' });
  const [showAll, setShowAll] = useState(false);
  const [productId, setProductId] = useState('');
  const [eventType, setEventType] = useState('click');
  const sequence = useRef(0);

  useEffect(() => subscribeToEvents({
    onEvent: (event) => {
      const type = ['view', 'click', 'purchase'].includes(event.event_type) ? event.event_type : 'click';
      const received = {
        id: `${event.offset ?? 'live'}-${sequence.current++}`,
        user_id: String(event.user_id ?? ''),
        product_id: String(event.product_id ?? ''),
        event_type: type,
        timestamp: event.received_at ?? event.timestamp ?? new Date().toISOString(),
        offset: event.offset ?? null,
      };
      setEvents((previous) => [received, ...previous].slice(0, MAX_EVENTS));
    },
    onStatus: (next) => setStatus(next ?? { status: 'connecting' }),
  }), []);

  const visibleEvents = useMemo(
    () => (showAll ? events : events.filter((event) => event.user_id === userId)),
    [events, showAll, userId],
  );
  const graph = useMemo(() => buildGraph(visibleEvents), [visibleEvents]);
  const counts = useMemo(() => visibleEvents.reduce((acc, event) => {
    acc[event.event_type] += 1;
    return acc;
  }, { view: 0, click: 0, purchase: 0 }), [visibleEvents]);

  const connected = status.status === 'connected';
  const statusLabel = connected
    ? 'Conectado a Kafka · SSE'
    : status.status === 'reconnecting'
      ? 'Reconectando…'
      : status.status === 'error'
        ? `Error: ${status.message ?? 'stream caído'}`
        : status.status === 'starting'
          ? 'Iniciando consumidor…'
          : 'Conectando…';

  const publish = (submitEvent) => {
    submitEvent.preventDefault();
    const id = productId.trim();
    if (!id || !userId) return;
    onFireEvent({ id, title: id, category: null }, eventType);
    setProductId('');
  };

  return (
    <div className="graph-explorer live-explorer">
      <section className="panel graph-panel live-panel">
        <div className="panel-header">
          <div>
            <h2>Grafo en tiempo real</h2>
            <p className="muted">
              Nodos y aristas construidos con los mensajes que llegan por <code>/api/stream/events</code>.
              No consulta Neo4j ni la actividad local.
            </p>
          </div>
          <span className={`live-status ${connected ? 'connected' : ''}`} role="status">
            <span className={`live-dot ${connected ? '' : 'busy'}`} aria-hidden="true" />
            {statusLabel}
          </span>
        </div>

        <div className="live-controls">
          <label className="live-filter">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(event) => setShowAll(event.target.checked)}
            />
            Ver eventos de todos los usuarios
          </label>
          <form className="live-publish" onSubmit={publish}>
            <input
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              placeholder="ID de producto"
              aria-label="ID de producto"
              spellCheck="false"
            />
            <select value={eventType} onChange={(event) => setEventType(event.target.value)} aria-label="Tipo de evento">
              {interactionTypes.map(({ type, label }) => <option key={type} value={type}>{label}</option>)}
            </select>
            <button type="submit" className="primary" disabled={!productId.trim() || !userId}>Publicar</button>
          </form>
          <button type="button" onClick={onBrowse}>Elegir producto en el catálogo</button>
        </div>

        <dl className="graph-counters live-counters">
          {interactionTypes.map(({ type, plural }) => (
            <div key={type}><dt>{plural}</dt><dd>{counts[type]}</dd></div>
          ))}
          <div><dt>Eventos</dt><dd>{visibleEvents.length}</dd></div>
        </dl>

        {graph.users.length === 0 ? (
          <div className="empty-state">
            <p>
              {connected
                ? 'Esperando eventos nuevos. Publica un clic arriba o desde el catálogo para ver el grafo crecer.'
                : 'Conectando con el stream de eventos…'}
            </p>
          </div>
        ) : (
          <>
            <ul className="graph-legend" aria-label="Tipos de evento en vivo">
              {interactionTypes.map(({ type, label, color, dash }) => (
                <li key={type}>
                  <svg width="27" height="8" aria-hidden="true"><path d="M0 4H27" stroke={color} strokeWidth="3" strokeDasharray={dash} /></svg>
                  {label}
                </li>
              ))}
            </ul>
            <LiveSvg graph={graph} />
          </>
        )}
      </section>

      <section className="panel live-feed">
        <div className="panel-header">
          <h2>Eventos recibidos</h2>
          <span className="muted">Últimos {visibleEvents.length} · máx. {MAX_EVENTS}</span>
        </div>
        {visibleEvents.length === 0 ? (
          <p className="muted">Todavía no hay eventos en esta vista.</p>
        ) : (
          <ul className="live-event-list">
            {visibleEvents.slice(0, 14).map((event) => (
              <li key={event.id} className="live-event-item">
                <time>{formatTime(event.timestamp)}</time>
                <span className={`event-label event-label--${event.event_type}`}>
                  {EVENT_LABEL[event.event_type]}
                </span>
                <span className="live-event-route">
                  <strong>{event.user_id}</strong> → {event.product_id}
                </span>
                <span className="muted live-offset">offset {event.offset ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
