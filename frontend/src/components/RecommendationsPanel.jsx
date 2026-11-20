import { useCallback, useEffect, useState } from 'react';
import { getRecommendations } from '../api.js';

export default function RecommendationsPanel({ userId, refreshKey }) {
  const [engine, setEngine] = useState('spark');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError('');
    try {
      setData(await getRecommendations(userId, engine));
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [userId, engine]);

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Recomendaciones para <code>{userId || '—'}</code></h2>
          <p className="muted">Elige el motor y observa la latencia medida en el backend.</p>
        </div>
        <div className="segmented">
          <button type="button" className={engine === 'spark' ? 'active' : ''} onClick={() => setEngine('spark')}>Spark ALS</button>
          <button type="button" className={engine === 'neo4j' ? 'active' : ''} onClick={() => setEngine('neo4j')}>Grafo Neo4j</button>
          <button type="button" onClick={load} disabled={loading}>↻</button>
        </div>
      </div>

      {error && <div className="alert">No se pudieron cargar recomendaciones: {error}</div>}
      {loading && <p className="muted">Consultando…</p>}
      {!loading && data && (
        <>
          <div className="latency-line">
            Latencia: <strong>{data.latency_ms} ms</strong> · {data.items.length} ítems
          </div>
          {data.items.length ? (
            <ol className="rec-list">
              {data.items.map((item) => (
                <li key={item.product_id}>
                  <span className="rank">#{item.rank}</span>
                  <span className="rec-title">{item.title || item.product_id}</span>
                  <span className="badge">{item.category || '—'}</span>
                  <span className="score">{Number(item.score).toFixed(3)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty-state">Sin resultados. Ejecuta el job de Spark o revisa los eventos del grafo.</div>
          )}
        </>
      )}
    </section>
  );
}
