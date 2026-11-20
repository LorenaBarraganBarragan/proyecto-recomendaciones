import { useCallback, useEffect, useRef, useState } from 'react';
import { getComparison, useMocks } from '../api.js';

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
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setData(null);
    setLoading(Boolean(userId));
    setError('');
    if (!userId) return;
    try {
      const result = await getComparison(userId);
      if (id === requestId.current) setData(result);
    } catch (err) {
      if (id === requestId.current) setError(err.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Spark vs. Grafo</h2>
          <p className="muted">
            {useMocks ? 'Resultados simulados y latencias ficticias para ' : 'Calidad y latencia medidas en el backend para '}
            <code>{userId || '—'}</code>.
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading || !userId}>{loading ? 'Consultando…' : '↻ Actualizar'}</button>
      </div>
      <p className="ranking-guide">
        La cobertura indica la proporción del cupo solicitado que devolvió cada motor.
        Las coincidencias cuentan recomendaciones presentes en la actividad reciente.
        Las puntuaciones ordenan cada lista y pueden usar escalas distintas. No representan precios ni porcentajes.
      </p>

      {error && <div className="alert">No se pudo generar la comparativa: {error}</div>}
      {data?.userId === userId && data && (
        <>
          {data.fasterEngine && (
            <div className="winner">⚡ {useMocks ? 'Menor latencia ficticia' : 'Motor más rápido'}: <strong>{data.fasterEngine === 'spark' ? 'Spark ALS' : 'Grafo Neo4j'}</strong></div>
          )}
          <div className="comparison-grid">
            <article className="engine-card">
              <header>
                <h3>Spark ALS</h3>
                <span className="latency">{useMocks && 'Ficticia · '}{data.spark.latency_ms == null ? '—' : `${data.spark.latency_ms} ms`}</span>
              </header>
              {data.spark.error ? <p className="alert">Spark no está disponible para esta consulta.</p> : <Items items={data.spark.items} />}
              <dl className="metrics">
                <div><dt>Cobertura</dt><dd>{data.quality?.spark?.coverage ?? '—'}</dd></div>
                <div><dt>Coincidencias recientes</dt><dd>{data.quality?.spark?.recentOverlap ?? '—'}</dd></div>
                <div><dt>Edad del modelo (h)</dt><dd>{data.quality?.spark?.modelAgeHours ?? '—'}</dd></div>
              </dl>
              <ul className="notes">
                {data.quality?.spark?.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </article>

            <article className="engine-card">
              <header>
                <h3>Grafo Neo4j</h3>
                <span className="latency">{useMocks && 'Ficticia · '}{data.neo4j.latency_ms == null ? '—' : `${data.neo4j.latency_ms} ms`}</span>
              </header>
              {data.neo4j.error ? <p className="alert">Neo4j no está disponible para esta consulta.</p> : <Items items={data.neo4j.items} />}
              <dl className="metrics">
                <div><dt>Cobertura</dt><dd>{data.quality?.neo4j?.coverage ?? '—'}</dd></div>
                <div><dt>Usuarios vecinos</dt><dd>{useMocks ? '—' : (data.quality?.neo4j?.neighborUsers ?? '—')}</dd></div>
                <div><dt>Coincidencias recientes</dt><dd>{data.quality?.neo4j?.recentOverlap ?? '—'}</dd></div>
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
