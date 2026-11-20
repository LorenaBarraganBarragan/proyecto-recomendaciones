import { useEffect, useMemo, useState } from 'react';
import { getNeo4jGraph } from '../api.js';
import { interactionTypes } from '../session-activity.js';

function Neo4jStats({ graph }) {
  const categories = [...(graph?.stats?.categories ?? [])].sort((a, b) => a.localeCompare(b));
  const nodes = graph?.nodes ?? [];
  const byCategory = new Map();

  nodes.forEach((node) => {
    const key = node.category || 'Sin categoría';
    byCategory.set(key, (byCategory.get(key) ?? 0) + node.total);
  });
  const affinity = [...byCategory.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = affinity.reduce((sum, [, count]) => sum + count, 0);

  return (
    <section className="panel graph-stats">
      <h2>Datos persistidos en Neo4j</h2>
      <p className="muted">
        Resultado de consultas Cypher sobre el grafo. No incluye actividad local del navegador.
      </p>
      <dl className="graph-counters">
        <div><dt>Relaciones</dt><dd>{graph?.stats?.relationships ?? 0}</dd></div>
        <div><dt>Productos</dt><dd>{graph?.stats?.products ?? 0}</dd></div>
        {interactionTypes.map(({ type, plural }) => (
          <div key={type}><dt>{plural}</dt><dd>{graph?.stats?.[type === 'view' ? 'views' : type === 'click' ? 'clicks' : 'purchases'] ?? 0}</dd></div>
        ))}
      </dl>
      {affinity.length > 0 && (
        <>
          <h3>Afinidad por categoría</h3>
          <p className="muted">Proporción de relaciones del grafo con categoría conocida.</p>
          <ul className="category-affinity">
            {affinity.map(([category, count]) => (
              <li key={category}>
                <span>{category}</span>
                <progress value={count} max={total} aria-label={`Relaciones en ${category}`} />
                <strong>{Math.round(count / total * 100)} %</strong>
              </li>
            ))}
          </ul>
        </>
      )}
      {categories.length > 0 && affinity.length === 0 && (
        <p className="muted">Categorías disponibles: {categories.join(', ')}.</p>
      )}
    </section>
  );
}

function GraphNode({ label, selected, onSelect, children }) {
  return (
    <g
      className="graph-node"
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {children}
    </g>
  );
}

function Neo4jGraph({ userId, graph, onBrowse }) {
  const [selectedId, setSelectedId] = useState(null);
  const nodes = (graph?.nodes ?? []).map((node, index) => ({ ...node, y: 33 + index * 50 }));
  const visible = nodes.slice(0, 8);
  const current = visible.find(({ id }) => id === selectedId);
  const height = Math.max(140, visible.length * 50 + 16);
  const hubY = height / 2;

  return (
    <>
      <p className="muted">
        Usuario y productos conectados por relaciones <code>VIEWED</code>, <code>CLICKED</code> y
        {' '}<code>PURCHASED</code> leídas de Neo4j. Selecciona un nodo para ver sus relaciones.
      </p>
      {visible.length === 0 ? (
        <div className="empty-state">
          <p>Este usuario todavía no tiene relaciones persistidas en el grafo.</p>
          <button type="button" onClick={onBrowse}>Abrir un producto en el catálogo</button>
        </div>
      ) : (
        <>
          <ul className="graph-legend" aria-label="Tipos de conexión">
            {interactionTypes.map(({ type, label, color, dash }) => (
              <li key={type}>
                <svg width="27" height="8" aria-hidden="true"><path d="M0 4H27" stroke={color} strokeWidth="3" strokeDasharray={dash} /></svg>
                {label}
              </li>
            ))}
          </ul>
          <svg className="session-graph" viewBox={`0 0 360 ${height}`} role="group" aria-label="Grafo persistido de usuario y productos en Neo4j">
            {visible.map(({ id, y, counts }) => (
              <g key={id} opacity={current && current.id !== id ? 0.2 : 1} aria-hidden="true">
                {interactionTypes.map(({ type, color, dash }, index) => counts[type] > 0 && (
                  <path
                    key={type}
                    fill="none"
                    stroke={color}
                    strokeDasharray={dash}
                    strokeWidth={current?.id === id ? 3.5 : 2}
                    d={`M 70 ${hubY + (index - 1) * 7} C 124 ${hubY + (index - 1) * 9}, 123 ${y + (index - 1) * 7}, 167 ${y + (index - 1) * 7}`}
                  />
                ))}
              </g>
            ))}
            <GraphNode label={`Usuario ${userId}`} selected={!current} onSelect={() => setSelectedId(null)}>
              <circle cx="44" cy={hubY} r="26" fill="#4540bb" stroke="white" strokeWidth="2" />
              <text x="44" y={hubY + 4} textAnchor="middle" fill="white" fontSize="11" fontWeight="700">Usuario</text>
            </GraphNode>
            {visible.map(({ id, title, y }) => (
              <GraphNode key={id} label={title} selected={current?.id === id} onSelect={() => setSelectedId(id)}>
                <rect
                  x="167"
                  y={y - 18}
                  width="179"
                  height="36"
                  rx="9"
                  fill={current?.id === id ? '#e9e7ff' : 'white'}
                  stroke={current?.id === id ? '#4f46e5' : '#c6cde0'}
                />
                <text x="177" y={y + 4} fill="#202943" fontSize="11.5" fontWeight="650">
                  {title.length > 25 ? `${title.slice(0, 24)}…` : title}
                </text>
              </GraphNode>
            ))}
          </svg>
          {nodes.length > visible.length && (
            <p className="muted">El grafo muestra los ocho productos con relaciones más recientes.</p>
          )}
        </>
      )}
      <div className="graph-selection" aria-live="polite">
        <h3>{current ? current.title : userId || 'Usuario activo'}</h3>
        <p>
          {current
            ? `${current.category || 'Sin categoría'} · ${interactionTypes
              .map(({ type, plural }) => `${plural.toLowerCase()} ${current.counts[type]}`).join(' · ')}`
            : `${graph?.stats?.products ?? 0} productos conectados · ${graph?.stats?.relationships ?? 0} relaciones en Neo4j`}
        </p>
      </div>
      {graph?.query && (
        <>
          <h3>Consulta ejecutada</h3>
          <pre className="query-code graph-query">{graph.query}</pre>
          <p className="muted">
            Generada {graph.generatedAt ? new Date(graph.generatedAt).toLocaleTimeString() : '—'} · fuente {graph.source}.
          </p>
        </>
      )}
    </>
  );
}

export default function GraphExplorer({ userId, refreshKey, onBrowse }) {
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!userId) return undefined;
    let active = true;
    setLoading(true);
    getNeo4jGraph(userId, 50)
      .then((data) => {
        if (!active) return;
        setGraph(data);
        setError('');
      })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId, refreshKey, reloadKey]);

  useEffect(() => setGraph(null), [userId]);

  return (
    <div className="graph-explorer">
      <div className="graph-columns">
        <section className="panel graph-panel">
          <div className="panel-header">
            <h2>
              Explorador de grafo Neo4j {loading && <span className="muted">· consultando…</span>}
            </h2>
            <button type="button" onClick={() => setReloadKey((value) => value + 1)} disabled={loading || !userId}>
              Actualizar
            </button>
          </div>
          {error && <div className="alert">No se pudo leer Neo4j: {error}</div>}
          <Neo4jGraph
            key={userId}
            userId={userId}
            graph={graph}
            onBrowse={onBrowse}
          />
        </section>
        <Neo4jStats graph={graph} />
      </div>
    </div>
  );
}
