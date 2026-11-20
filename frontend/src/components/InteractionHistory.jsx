const labels = { view: 'Vista', click: 'Clic', purchase: 'Compra' };
const formatTime = new Intl.DateTimeFormat('es-CO', { timeStyle: 'medium' });

export default function InteractionHistory({ userId, interactions, simulated }) {
  return (
    <section className="panel interaction-history" aria-label="Interacciones recientes">
      <h2>Interacciones recientes</h2>
      <p className="muted">
        {simulated ? 'Eventos simulados' : 'Eventos aceptados por la API'} en esta sesión
        {userId && <> para <code>{userId}</code></>}.
      </p>
      {interactions.length > 0 ? (
        <ol className="interaction-list">
          {interactions.map(({ id, eventType, title, timestamp }) => (
            <li key={id}>
              <span className={`event-label event-label--${eventType}`}>{labels[eventType]}</span>
              <span>{title}</span>
              <time dateTime={timestamp}>{formatTime.format(new Date(timestamp))}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">{userId ? 'Todavía no hay interacciones registradas.' : 'Selecciona un usuario para ver su actividad.'}</p>
      )}
    </section>
  );
}
