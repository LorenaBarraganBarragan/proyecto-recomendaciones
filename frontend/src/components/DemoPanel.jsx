import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDemoCloud,
  getDemoFlow,
  getDemoQueries,
  getDemoScale,
  postEvent,
} from '../api.js';

const QUERY_TABS = [
  { id: 'cql', label: 'CQL · Cassandra', engine: 'CQL' },
  { id: 'cypher', label: 'Cypher · Neo4j', engine: 'Cypher' },
  { id: 'neighbors', label: 'Vecinos · Spark', engine: 'Spark' },
];

const fmt = (value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString('es-CO'));
const ms = (value) => (value === null || value === undefined ? '—' : `${Number(value).toFixed(1)} ms`);
const mb = (value) => (value ? `${(Number(value) / 1024 / 1024).toFixed(1)} MB` : '—');
const time = (value) => (value ? new Date(value).toLocaleTimeString() : '—');

function Stage({ stage, pulsed }) {
  return (
    <div className={`flow-stage ${stage.status} ${pulsed ? 'pulsed' : ''}`}>
      <div className="flow-stage-head">
        <span className="stage-dot" />
        <strong>{stage.name}</strong>
      </div>
      <p>{stage.detail}</p>
      <small>{stage.status === 'ok' ? ms(stage.latency_ms) : (stage.error ?? 'sin conexión')}</small>
    </div>
  );
}

function QueryBlock({ query }) {
  if (!query) return <p className="muted">Ejecutando consulta…</p>;
  if (query.status !== 'ok') {
    return <div className="alert">Error en {query.engine}: {query.error}</div>;
  }

  const columns = query.rows.length ? Object.keys(query.rows[0]) : [];
  return (
    <div className="query-result">
      <pre className="query-code">{query.query}</pre>
      <div className="query-meta">
        <span className={`badge ${query.engine.toLowerCase()}`}>{query.engine}</span>
        <span className="muted">{query.rowCount} filas · {ms(query.totalLatency_ms ?? query.latency_ms)}</span>
      </div>
      {query.rows.length ? (
        <div className="table-wrap">
          <table className="demo-table">
            <thead>
              <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {query.rows.slice(0, 10).map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column}>
                      {Array.isArray(row[column])
                        ? `[${row[column].join(', ')}]`
                        : String(row[column] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">La consulta no devolvió filas para este usuario.</p>
      )}
      <p className="query-explain"><span>💡</span> {query.explanation}</p>
    </div>
  );
}

export default function DemoPanel({ userId, refreshKey, onFireEvent }) {
  const [flow, setFlow] = useState(null);
  const [queries, setQueries] = useState(null);
  const [scale, setScale] = useState(null);
  const [cloud, setCloud] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [queryTab, setQueryTab] = useState('cql');
  const [productId, setProductId] = useState('10');
  const [pulsed, setPulsed] = useState([]);
  const previousCounters = useRef(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const [flowRes, queriesRes, scaleRes] = await Promise.allSettled([
      getDemoFlow(),
      getDemoQueries(userId),
      getDemoScale(userId),
    ]);

    if (flowRes.status === 'fulfilled') setFlow(flowRes.value);
    if (queriesRes.status === 'fulfilled') setQueries(queriesRes.value);
    if (scaleRes.status === 'fulfilled') setScale(scaleRes.value);
    const failures = [flowRes, queriesRes, scaleRes]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason.message);
    setError(failures.length ? `No se pudo consultar: ${failures.join('; ')}` : '');
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh, refreshKey]);

  useEffect(() => {
    let active = true;
    const check = () => getDemoCloud().then((data) => { if (active) setCloud(data); }).catch(() => {});
    check();
    const timer = setInterval(check, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  // Resalta los componentes cuyo contador cambió: evidencia visual del flujo.
  useEffect(() => {
    if (!flow?.counters) return undefined;
    const previous = previousCounters.current;
    previousCounters.current = flow.counters;
    if (!previous) return undefined;

    const changed = [];
    const links = {
      kafkaMessages: ['kafka', 'api'],
      cassandraSessions: ['cassandra', 'consumer'],
      neo4jRelationships: ['neo4j', 'consumer'],
      sparkNeighborRecommendations: ['spark-neighbors'],
    };
    for (const [key, stages] of Object.entries(links)) {
      if (previous[key] !== flow.counters[key]) changed.push(...stages);
    }
    if (!changed.length) return undefined;

    setPulsed([...new Set(changed)]);
    const timer = setTimeout(() => setPulsed([]), 2800);
    return () => clearTimeout(timer);
  }, [flow]);

  const fireDemoEvent = async () => {
    if (!productId.trim() || !onFireEvent) return;
    await onFireEvent(productId.trim(), 'click');
    setTimeout(refresh, 1400);
  };

  const activeQuery = queries?.queries?.find((item) => item.id === queryTab);
  const comparison = scale?.comparison;

  return (
    <div className="demo-panel">
      <div className="demo-header">
        <div>
          <h2>Demo en vivo</h2>
          <p className="muted">
            Flujo entre componentes · consultas reales · escala · servicio en la nube verificado
          </p>
        </div>
        <div className="demo-actions">
          <span className={`live-dot ${loading ? 'busy' : ''}`} />
          <span className="muted">Auto-refresh 4 s</span>
          <button type="button" onClick={refresh} disabled={loading}>↻ Actualizar</button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {!userId && <div className="alert">Escribe un usuario activo arriba para ver las consultas.</div>}

      {/* 1. Flujo */}
      <section className="panel demo-section">
        <div className="demo-section-head">
          <div>
            <span className="section-number">1</span>
            <h3>Datos fluyendo por la arquitectura</h3>
          </div>
          <div className="demo-fire">
            <input
              aria-label="ID de producto para el evento"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              spellCheck="false"
            />
            <button type="button" className="primary" onClick={fireDemoEvent} disabled={!userId}>
              Publicar click
            </button>
          </div>
        </div>
        <p className="muted">
          Publica un evento y observa cómo el resaltado recorre API → Kafka → consumidor → almacenes.
        </p>
        <div className="flow-line">
          {flow?.stages.map((stage, index) => (
            <div className="flow-cell" key={stage.id}>
              <Stage stage={stage} pulsed={pulsed.includes(stage.id)} />
              {index < flow.stages.length - 1 && <span className="flow-arrow">→</span>}
            </div>
          ))}
          {!flow && <p className="muted">Leyendo estado de los componentes…</p>}
        </div>
        {flow && (
          <>
            <div className="counter-row">
              <div><strong>{fmt(flow.counters.kafkaMessages)}</strong><span>mensajes Kafka</span></div>
              <div><strong>{fmt(flow.counters.cassandraSessions)}</strong><span>sesiones Cassandra</span></div>
              <div><strong>{fmt(flow.counters.neo4jRelationships)}</strong><span>relaciones Neo4j</span></div>
              <div><strong>{fmt(flow.counters.sparkNeighborRecommendations)}</strong><span>recs. vecinales</span></div>
            </div>
            <h4>Últimos eventos observados en los almacenes</h4>
            <div className="event-list">
              {flow.recent.length ? flow.recent.map((event, index) => (
                <div className="event-item" key={`${event.user_id}-${event.product_id}-${index}`}>
                  <strong>{event.event_type}</strong>
                  <span>{event.user_id} → producto {event.product_id}</span>
                  <span className="muted">{time(event.timestamp)}</span>
                  <div className="store-badges">
                    {event.stores.map((store) => <span className="badge" key={store}>{store}</span>)}
                  </div>
                </div>
              )) : <p className="muted">Todavía no hay eventos recientes.</p>}
            </div>
          </>
        )}
      </section>

      {/* 2. Consultas */}
      <section className="panel demo-section">
        <div className="demo-section-head">
          <div>
            <span className="section-number">2</span>
            <h3>Consulta en vivo con resultado explicado</h3>
          </div>
          <span className="muted">Última ejecución: {time(queries?.generatedAt)}</span>
        </div>
        <div className="query-tabs">
          {QUERY_TABS.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={queryTab === tab.id ? 'active' : ''}
              onClick={() => setQueryTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <QueryBlock query={activeQuery} />
      </section>

      {/* 3. Escala */}
      <section className="panel demo-section">
        <div className="demo-section-head">
          <div>
            <span className="section-number">3</span>
            <h3>Evidencia de escala y comparación de enfoques</h3>
          </div>
          <span className="muted">Pre-cargado antes de la exposición</span>
        </div>
        <div className="scale-grid">
          <div className="scale-card">
            <span>Filas leídas del dataset</span>
            <strong>{fmt(scale?.preloaded.rowsScanned)}</strong>
          </div>
          <div className="scale-card">
            <span>Reservorio determinista</span>
            <strong>{fmt(scale?.preloaded.poolSize)}</strong>
          </div>
          <div className="scale-card">
            <span>Reseñas asignadas</span>
            <strong>{fmt(scale?.preloaded.reviewsAssigned)}</strong>
          </div>
          <div className="scale-card">
            <span>Tiempo de ingesta</span>
            <strong>{scale?.preloaded.durationMs ? `${(scale.preloaded.durationMs / 1000).toFixed(1)} s` : '—'}</strong>
          </div>
        </div>
        <p className="muted scale-note">{scale?.note}</p>
        {comparison?.sparkNeighbors && (
          <div className="compare-table-wrap">
            <table className="demo-table">
              <thead>
                <tr><th>Motor</th><th>Ítems</th><th>Latencia</th><th>Cobertura</th><th>Origen</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>Spark vecinal</td>
                  <td>{comparison.sparkNeighbors.items}</td>
                  <td>{ms(comparison.sparkNeighbors.latency_ms)}</td>
                  <td>{fmt(Math.round(comparison.sparkNeighbors.coverage * 100))}%</td>
                  <td>{comparison.sparkNeighbors.source ?? 'spark-neighbors'}</td>
                </tr>
                <tr>
                  <td>Grafo Neo4j</td>
                  <td>{comparison.neo4j.items}</td>
                  <td>{ms(comparison.neo4j.latency_ms)}</td>
                  <td>{fmt(Math.round(comparison.neo4j.coverage * 100))}%</td>
                  <td>vecinos: {comparison.neo4j.neighborUsers}</td>
                </tr>
              </tbody>
            </table>
            <p className="muted">
              Motor más rápido en esta lectura: <strong>{{
                'spark-neighbors': 'Spark vecinal',
                neo4j: 'Grafo Neo4j',
              }[comparison.fasterEngine] ?? comparison.fasterEngine ?? '—'}</strong>
            </p>
            <ul className="scale-notes">
              {comparison.notes.map((note, index) => <li key={index}>{note}</li>)}
            </ul>
          </div>
        )}
        {scale?.liveCounts && (
          <p className="muted">
            En vivo ahora: {fmt(scale.liveCounts.sessions)} sesiones · {fmt(scale.liveCounts.reviews)} reseñas ·
            {' '}{fmt(scale.liveCounts.products)} productos · {fmt(scale.liveCounts.sparkNeighbors)} recomendaciones vecinales.
          </p>
        )}
      </section>

      {/* 4. Nube */}
      <section className="panel demo-section">
        <div className="demo-section-head">
          <div>
            <span className="section-number">4</span>
            <h3>Servicio en la nube verificado antes de empezar</h3>
          </div>
          <span className={`badge ${cloud?.verified ? 'ok-badge' : 'error-badge'}`}>
            {cloud?.verified ? 'S3 accesible' : (cloud ? 'Sin acceso' : 'Verificando…')}
          </span>
        </div>
        {cloud ? (
          <div className="cloud-grid">
            <div><span>Bucket</span><strong>{cloud.bucket ?? '—'}</strong></div>
            <div><span>Objeto</span><strong>{cloud.key ?? '—'}</strong></div>
            <div><span>Tamaño</span><strong>{mb(cloud.sizeBytes)}</strong></div>
            <div><span>Última modificación</span><strong>{cloud.lastModified ? new Date(cloud.lastModified).toLocaleString() : '—'}</strong></div>
            <div><span>Región / perfil</span><strong>{cloud.region} / {cloud.profile}</strong></div>
            <div><span>HeadObject</span><strong>{ms(cloud.latency_ms)}</strong></div>
          </div>
        ) : <p className="muted">Verificando credenciales y objeto en S3…</p>}
        {cloud?.error && <div className="alert">{cloud.error}</div>}
        <p className="muted">
          Verificado con un <code>HeadObject</code> real a las {time(cloud?.checkedAt)}
          {cloud?.cached ? ' (resultado en caché de 30 s)' : ''}.
        </p>
      </section>
    </div>
  );
}
