import { useCallback, useEffect, useState } from 'react';
import { getComparison } from '../api.js';

function Items({ items }) {
  if (!items?.length) return <p className="muted">Sin recomendaciones.</p>;
  return (
    <ol className="rec-list compact">
      {items.map((item) => (
        <li key={item.product_id}>
          <span className="rank">#{item.rank}</span>
          <span className="rec-title">{item.title || item.product_id}</span>
          <span className="score">{Number(item.score).toFixed(2)}</span>
        </li>
      ))}
    </ol>
  );
}

export default function ComparisonPanel({ userId, refreshKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError('');
    try {
      setData(await getComparison(userId));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Spark vs. Grafo</h2>
          <p className="muted">Calidad y latencia para <code>{userId || '—'}</code>, medidas en el backend.</p>
        </div>
        <button type="button" onClick={load} disabled={loading}>{loading ? 'Consultando…' : '↻ Actualizar'}</button>
      </div>

      {error && <div className="alert">No se pudo generar la comparativa: {error}</div>}
      {data && (
        <>
          {data.fasterEngine && (
            <div className="winner">⚡ Motor más rápido: <strong>{data.fasterEngine === 'spark' ? 'Spark ALS' : 'Grafo Neo4j'}</strong></div>
          )}
          <div className="comparison-grid">
            <article className="engine-card">
              <header>
                <h3>Spark ALS</h3>
                <span className="latency">{data.spark.latency_ms ?? '—'} ms</span>
              </header>
              <Items items={data.spark.items} />
              <dl className="metrics">
                <div><dt>Cobertura</dt><dd>{data.quality?.spark?.coverage ?? '—'}</dd></div>
                <div><dt>Overlap con clics recientes</dt><dd>{data.quality?.spark?.recentOverlap ?? '—'}</dd></div>
                <div><dt>Edad del modelo (h)</dt><dd>{data.quality?.spark?.modelAgeHours ?? '—'}</dd></div>
              </dl>
              <ul className="notes">
                {data.quality?.spark?.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </article>

            <article className="engine-card">
              <header>
                <h3>Grafo Neo4j</h3>
                <span className="latency">{data.neo4j.latency_ms ?? '—'} ms</span>
              </header>
              <Items items={data.neo4j.items} />
              <dl className="metrics">
                <div><dt>Cobertura</dt><dd>{data.quality?.neo4j?.coverage ?? '—'}</dd></div>
                <div><dt>Usuarios vecinos</dt><dd>{data.quality?.neo4j?.neighborUsers ?? '—'}</dd></div>
                <div><dt>Overlap con clics recientes</dt><dd>{data.quality?.neo4j?.recentOverlap ?? '—'}</dd></div>
              </dl>
              <ul className="notes">
                {data.quality?.neo4j?.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </article>
          </div>
        </>
      )}
    </section>
  );
}
