import ProductImage from './ProductImage.jsx';

const money = (value) => new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
}).format(value || 0);

export default function ProductCatalog({
  products,
  hasMore,
  loading,
  query,
  total,
  onQueryChange,
  onSelect,
  onLoadMore,
}) {
  return (
    <div className="catalog">
      <div className="catalog-toolbar">
        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Buscar por título, categoría, marca o descripción…"
            aria-label="Buscar productos"
          />
        </label>
        {total !== null && (
          <span className="muted result-count">
            {total.toLocaleString('es-CO')} {total === 1 ? 'resultado' : 'resultados'}
          </span>
        )}
      </div>

      {!products.length && !loading ? (
        <div className="empty-state">
          {query
            ? `No hay productos que coincidan con «${query}».`
            : 'No hay productos. Ejecuta la ingesta y recarga la página.'}
        </div>
      ) : (
        <>
          <div className="product-grid">
            {products.map((product) => (
              <article
                key={product.id}
                className="product-card"
                role="button"
                tabIndex={0}
                onClick={() => onSelect(product)}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
                    event.preventDefault();
                    onSelect(product);
                  }
                }}
              >
                <ProductImage src={product.image} title={product.title} lazy />
                <div className="product-body">
                  <span className="badge">{product.category}</span>
                  <h3>{product.title}</h3>
                  <div className="product-meta">
                    <span className="stars">★ {Number(product.rating || 0).toFixed(1)}</span>
                    <strong>{money(product.price)}</strong>
                  </div>
                  <span className="card-hint">Ver detalle y reseñas →</span>
                </div>
              </article>
            ))}
          </div>

          {hasMore && (
            <button className="load-more" type="button" onClick={onLoadMore} disabled={loading}>
              {loading ? 'Cargando…' : 'Cargar más productos'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
