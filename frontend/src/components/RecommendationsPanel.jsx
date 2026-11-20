import { useCallback, useEffect, useRef, useState } from 'react';
import { getRecommendations } from '../api.js';

const SOURCE_LABEL = {
  'spark-neighbors': 'Spark vecinal',
  'spark-neighbors-online': 'Vecinal en vivo',
};

export default function RecommendationsPanel({ userId, refreshKey }) {
  const [engine, setEngine] = useState('spark-neighbors');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setData(null);
    setLoading(Boolean(userId));
    setError('');
    if (!userId) return;
    try {
      const result = await getRecommendations(userId, engine);
      if (id === requestId.current) setData(result);
    } catch (err) {
      if (id === requestId.current) {
        setError(err.message);
        setData(null);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [userId, engine]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Si el job de Spark termina después de abrir la página, el panel se queda
  // con la primera respuesta vacía: reintentamos hasta que haya resultados.
  useEffect(() => {
    if (!userId || error || loading || (data && data.items.length)) return undefined;
    const timer = setInterval(() => { load(); }, 5000);
    return () => clearInterval(timer);
  }, [userId, error, loading, data, load]);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Recomendaciones para <code>{userId || '—'}</code></h2>
          <p className="muted">Elige el motor y observa la latencia medida en el backend.</p>
        </div>
        <div className="segmented" role="group" aria-label="Motor de recomendación">
          <button type="button" className={engine === 'spark-neighbors' ? 'active' : ''} aria-pressed={engine === 'spark-neighbors'} onClick={() => setEngine('spark-neighbors')}>Spark vecinal</button>
          <button type="button" className={engine === 'neo4j' ? 'active' : ''} aria-pressed={engine === 'neo4j'} onClick={() => setEngine('neo4j')}>Grafo Neo4j</button>
          <button type="button" className="segmented-refresh" onClick={load} disabled={loading || !userId} title="Actualizar recomendaciones" aria-label="Actualizar recomendaciones">↻</button>
        </div>
      </div>
      <div className="ranking-guide">
        <p><strong>Spark vecinal.</strong> Busca usuarios con productos en común y recomienda lo que esos vecinos vieron. Cada ítem indica cuántos vecinos lo respaldan y reacciona a los clics sin reentrenar.</p>
        <p><strong>Grafo Neo4j.</strong> Recorre las relaciones del grafo para encontrar el mismo vecindario. El consumidor actualiza el grafo en cuanto llega un evento de Kafka.</p>
        <p>Las puntuaciones ordenan los productos dentro de cada motor. No son precios ni porcentajes y sus escalas pueden ser distintas.</p>
      </div>

      {error && <div className="alert">No se pudieron cargar recomendaciones: {error}</div>}
      {loading && <p className="muted">Consultando…</p>}
      {!loading && data?.userId === userId && data?.engine === engine && (
        <>
          <div className="latency-line">
            Latencia: <strong>{data.latency_ms} ms</strong> · {data.items.length} ítems{' '}
            {data.source && <span className="badge">{SOURCE_LABEL[data.source] ?? data.source}</span>}
          </div>
          {data.note && <p className="muted cold-start-note">{data.note}</p>}
          {data.items.length ? (
            <ol className="rec-list">
              {data.items.map((item) => (
                <li key={item.product_id}>
                  <span className="rank">#{item.rank}</span>
                  <span className="rec-title">{item.title || item.product_id}</span>
                  <span className="badge">{item.category || '—'}</span>
                  <span className="score">{Number(item.score).toFixed(3)}</span>
                  {item.neighbor_count > 0 && (
                    <span className="muted neighbor-hint">{item.neighbor_count} {item.neighbor_count === 1 ? 'vecino' : 'vecinos'}</span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty-state">Sin resultados. Reintentando automáticamente… Ejecuta el job vecinal de Spark o revisa los eventos del grafo.</div>
          )}
        </>
      )}
    </section>
  );
}
