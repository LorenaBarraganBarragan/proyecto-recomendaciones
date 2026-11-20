import { useState } from 'react';

export default function ProductImage({ src, title, lazy = false }) {
  const [failedSource, setFailedSource] = useState(null);

  return (
    <div className="product-image">
      {src && src !== failedSource ? (
        <img src={src} alt={title} loading={lazy ? 'lazy' : undefined} onError={() => setFailedSource(src)} />
      ) : (
        <span className="image-fallback">Imagen no disponible</span>
      )}
    </div>
  );
}
