import { useState } from 'react';
import { interactionTypes } from '../session-activity.js';
import EventFlow from './EventFlow.jsx';

function SessionStats({ activity, simulated }) {
  const categories = [...activity.categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = categories.reduce((sum, [, count]) => sum + count, 0);

  return (
    <section className="panel graph-stats">
      <h2>Actividad de la sesión</h2>
      <p className="muted">{simulated ? 'Interacciones simuladas del usuario activo.' : 'Interacciones aceptadas por la API en esta pestaña del navegador.'}</p>
      <dl className="graph-counters">
        {interactionTypes.map(({ type, plural }) => (
          <div key={type}><dt>{plural}</dt><dd>{activity.counts[type]}</dd></div>
        ))}
      </dl>
      {categories.length >= 2 && (
        <>
          <h3>Afinidad por categoría</h3>
          <p className="muted">Proporción de interacciones de la sesión con categoría conocida.</p>
          <ul className="category-affinity">
            {categories.map(([category, count]) => (
              <li key={category}>
                <span>{category}</span>
                <progress value={count} max={total} aria-label={`Interacciones en ${category}`} />
                <strong>{Math.round(count / total * 100)} %</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function GraphNode({ label, selected, onSelect, children }) {
  return (
    <g className="graph-node" role="button" tabIndex={0} aria-label={label} aria-pressed={selected}
      onClick={onSelect} onKeyDown={(event) => {
        if (['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          onSelect();
        }
      }}>
      {children}
    </g>
  );
}

function SessionGraph({ userId, activity, onBrowse }) {
  const [selectedId, setSelectedId] = useState(null);
  const nodes = [...activity.products.values()].sort((a, b) => b.lastSequence - a.lastSequence)
    .slice(0, 8).map((product, index) => ({ ...product, y: 33 + index * 50 }));
  const current = nodes.find(({ id }) => id === selectedId);
  const height = Math.max(140, nodes.length * 50 + 16);
  const hubY = height / 2;

  return (
    <>
      <p className="muted">Relaciones simuladas de esta sesión. Selecciona un nodo para ver sus interacciones.</p>
      {nodes.length === 0 ? (
        <div className="empty-state">
          <p>Abre un producto del catálogo para añadir tu primera conexión.</p>
          <button type="button" onClick={onBrowse}>Ir al catálogo</button>
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
          <svg className="session-graph" viewBox={`0 0 360 ${height}`} role="group" aria-label="Grafo interactivo de usuario y productos">
            {nodes.map(({ id, y, counts }) => (
              <g key={id} opacity={current && current.id !== id ? 0.2 : 1} aria-hidden="true">
                {interactionTypes.map(({ type, color, dash }, index) => counts[type] > 0 && (
                  <path key={type} fill="none" stroke={color} strokeDasharray={dash} strokeWidth={current?.id === id ? 3.5 : 2}
                    d={`M 70 ${hubY + (index - 1) * 7} C 124 ${hubY + (index - 1) * 9}, 123 ${y + (index - 1) * 7}, 167 ${y + (index - 1) * 7}`} />
                ))}
              </g>
            ))}
            <GraphNode label={`Usuario ${userId}`} selected={!current} onSelect={() => setSelectedId(null)}>
              <circle cx="44" cy={hubY} r="26" fill="#4540bb" stroke="white" strokeWidth="2" />
              <text x="44" y={hubY + 4} textAnchor="middle" fill="white" fontSize="11" fontWeight="700">Usuario</text>
            </GraphNode>
            {nodes.map(({ id, title, y }) => (
              <GraphNode key={id} label={title} selected={current?.id === id} onSelect={() => setSelectedId(id)}>
                <rect x="167" y={y - 18} width="179" height="36" rx="9" fill={current?.id === id ? '#e9e7ff' : 'white'}
                  stroke={current?.id === id ? '#4f46e5' : '#c6cde0'} />
                <text x="177" y={y + 4} fill="#202943" fontSize="11.5" fontWeight="650">
                  {title.length > 25 ? `${title.slice(0, 24)}…` : title}
                </text>
              </GraphNode>
            ))}
          </svg>
          {activity.products.size > nodes.length && <p className="muted">El grafo muestra los ocho productos más recientes.</p>}
        </>
      )}
      <div className="graph-selection" aria-live="polite">
        <h3>{current ? current.title : userId || 'Usuario activo'}</h3>
        <p>{current
          ? `${current.category || 'Sin categoría'} · ${interactionTypes.map(({ type, plural }) => `${plural.toLowerCase()} ${current.counts[type]}`).join(' · ')}`
          : `${activity.products.size} productos con interacciones en esta sesión`}</p>
      </div>
    </>
  );
}

export default function GraphExplorer({ userId, activity, simulated, onBrowse }) {
  return (
    <div className="graph-explorer">
      <div className="graph-columns">
        <section className="panel graph-panel">
          <h2>Explorador de grafo</h2>
          {simulated
            ? <SessionGraph key={userId} userId={userId} activity={activity} onBrowse={onBrowse} />
            : <p className="graph-selection">La API actual no entrega relaciones de Neo4j. La actividad de la sesión se muestra a continuación y en el historial.</p>}
        </section>
        <SessionStats activity={activity} simulated={simulated} />
      </div>
      <EventFlow simulated={simulated} hasEvents={activity.recent.length > 0} />
    </div>
  );
}
