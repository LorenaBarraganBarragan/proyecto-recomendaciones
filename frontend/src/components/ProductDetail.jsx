import { useEffect, useRef } from 'react';

const Stars = ({ rating }) => (
  <span className="stars" aria-label={`${rating} de 5`}>
    {'★'.repeat(Math.round(rating))}{'☆'.repeat(5 - Math.round(rating))}
    <small> {rating.toFixed(1)}</small>
  </span>
);

export default function ProductDetail({ product, reviews, loading, onClose, onEvent }) {
  const viewedRef = useRef(null);
  useEffect(() => {
    // Un único view por producto, incluso con el doble montaje de StrictMode.
    if (viewedRef.current === product.id) return;
    viewedRef.current = product.id;
    onEvent(product.id, 'view');
  }, [product.id, onEvent]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Cerrar">×</button>

        <div className="modal-header">
          {product.image && <img src={product.image} alt={product.title} />}
          <div>
            <span className="badge">{product.category}</span>
            <h2>{product.title}</h2>
            <p className="muted">{product.description || 'Producto del catálogo base.'}</p>
            <div className="modal-meta">
              <Stars rating={Number(product.rating || 0)} />
              <strong>${Number(product.price || 0).toFixed(2)}</strong>
            </div>
            <button className="primary" type="button" onClick={() => onEvent(product.id, 'purchase')}>
              Comprar (publica purchase)
            </button>
          </div>
        </div>

        <div className="reviews">
          <h3>Reseñas asignadas <span className="muted">({reviews.length || '…'})</span></h3>
          {loading && <p className="muted">Cargando reseñas…</p>}
          {!loading && !reviews.length && <p className="muted">Este producto aún no tiene reseñas.</p>}
          <ul className="review-list">
            {reviews.map((review) => (
              <li key={review.id}>
                <div className="review-head">
                  <span className="avatar">{review.user_id.slice(0, 2).toUpperCase()}</span>
                  <code>{review.user_id}</code>
                  <Stars rating={Number(review.rating)} />
                </div>
                <p>{review.text || 'Sin texto'}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
