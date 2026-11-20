const stages = [
  { name: 'React', description: 'Envía la interacción.' },
  { name: 'Express', description: 'Valida y responde.' },
  { name: 'Kafka', description: 'Recibe eventos para el consumidor.' },
  { name: 'Consumidor', description: 'Lee eventos y actualiza los datos.' },
  { name: 'Cassandra / Neo4j', description: 'Sesiones en Cassandra y relaciones en Neo4j.' },
];

export default function EventFlow({ simulated, hasEvents }) {
  return (
    <section className="panel event-flow">
      <h2>Flujo de eventos</h2>
      <p className="muted">
        {simulated
          ? 'Recorrido ilustrativo con estados simulados. Los eventos de la demo se guardan en memoria.'
          : 'Flujo previsto del sistema. HTTP 202 indica que la API aceptó la solicitud. El procesamiento posterior queda sin verificar desde la interfaz.'}
      </p>
      <ol className="flow-stages">
        {stages.map(({ name, description }) => (
          <li key={name}><strong>{name}</strong><span>{description}</span></li>
        ))}
      </ol>
      <p className="flow-status">
        {hasEvents
          ? simulated ? 'Esta sesión tiene eventos simulados registrados.' : 'Esta sesión tiene envíos aceptados por la API.'
          : 'El usuario activo todavía no tiene envíos confirmados en esta sesión.'}
      </p>
    </section>
  );
}
