import { useCallback, useEffect, useRef, useState } from 'react';
import { getRecommendations, useMocks } from '../api.js';

export default function RecommendationsPanel({ userId, refreshKey }) {
  const [engine, setEngine] = useState('spark');
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
      if (id === requestId.current) setError(err.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [userId, engine]);

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Recomendaciones para <code>{userId || '—'}</code></h2>
        </div>
        <div className="segmented">
          <button type="button" className={engine === 'spark' ? 'active' : ''} onClick={() => setEngine('spark')}>Spark ALS</button>
          <button type="button" className={engine === 'neo4j' ? 'active' : ''} onClick={() => setEngine('neo4j')}>Grafo Neo4j</button>
          <button type="button" aria-label="Actualizar recomendaciones" onClick={load} disabled={loading || !userId}>↻</button>
        </div>
      </div>
      <div className="ranking-guide">
        <p><strong>Spark ALS.</strong> {useMocks
          ? 'En la demo conserva una lista precalculada durante la sesión.'
          : 'Usa patrones del historial y cambia cuando se vuelve a entrenar el modelo.'}</p>
        <p><strong>Grafo Neo4j.</strong> {useMocks
          ? 'En la demo ajusta la afinidad por categoría con tus interacciones.'
          : 'Busca productos a partir de conexiones entre usuarios y productos. Incorpora la actividad conforme se actualiza el grafo.'}</p>
        <p>Las puntuaciones ordenan los productos dentro de cada motor. No son precios ni porcentajes y sus escalas pueden ser distintas.</p>
      </div>

      {error && <div className="alert">No se pudieron cargar recomendaciones: {error}</div>}
      {loading && <p className="muted">Consultando…</p>}
      {!loading && data?.userId === userId && data?.engine === engine && (
        <>
          <div className="latency-line">
            {useMocks ? 'Latencia ficticia' : 'Latencia'}: <strong>{data.latency_ms} ms</strong> · {data.items.length} ítems
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
