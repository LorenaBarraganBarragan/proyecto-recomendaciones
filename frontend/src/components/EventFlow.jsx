const DEFAULT_STAGES = [
  { name: 'React', description: 'Publica la interacción del usuario.' },
  { name: 'API Express', description: 'Valida y escribe en Kafka.' },
  { name: 'Kafka', description: 'Transporta el evento al consumidor.' },
  { name: 'Consumidor', description: 'Persiste en Cassandra y Neo4j.' },
  { name: 'Motores', description: 'Spark vecinal y grafo consultan los almacenes.' },
];

export default function EventFlow({ stages = DEFAULT_STAGES, hasEvents, revision }) {
  return (
    <section className="panel event-flow">
      <h2>Flujo de eventos</h2>
      <p className="muted">
        Componentes consultados en vivo por <code>/api/demo/flow</code>, con estado y latencia medidos en el backend.
      </p>
      <ol className="flow-stages">
        {stages.map((stage, index) => (
          <li key={stage.id ?? stage.name ?? index} className={stage.status ?? ''}>
            <strong>{stage.name}</strong>
            <span>{stage.description ?? stage.detail}</span>
            {stage.status && <small className="muted">{stage.status === 'ok' ? `${stage.latency_ms ?? 0} ms` : (stage.error ?? 'sin conexión')}</small>}
          </li>
        ))}
      </ol>
      <p className="flow-status">
        {hasEvents
          ? `Esta sesión tiene eventos publicados por la API. ${revision ? `Última revisión: ${revision}.` : ''}`
          : 'El usuario activo todavía no tiene eventos publicados en esta sesión.'}
      </p>
    </section>
  );
}
