const groups = [
  ['audio', ['Audífonos inalámbricos', 'Parlante compacto', 'Micrófono USB', 'Audífonos de estudio', 'Barra de sonido', 'Radio portátil']],
  ['hogar', ['Lámpara de escritorio', 'Jarra térmica', 'Reloj de pared', 'Organizador modular', 'Báscula de cocina', 'Luz de lectura']],
  ['deportes', ['Botella deportiva', 'Tapete de yoga', 'Cuerda de salto', 'Banda elástica', 'Mochila deportiva', 'Rodillo de masaje']],
  ['papelería', ['Cuaderno punteado', 'Set de marcadores', 'Agenda semanal', 'Estuche de lápices', 'Bloc de dibujo', 'Notas adhesivas']],
];

export const sampleUserIds = ['u_demo', 'u_demo_audio', 'u_demo_hogar', 'u_demo_deportes'];
export const snapshotDate = '2026-01-01T12:00:00.000Z';
const baseUrl = import.meta.env?.BASE_URL ?? '/';

export const products = groups.flatMap(([category, titles], groupIndex) =>
  titles.map((title, index) => {
    const id = String(groupIndex * 6 + index + 1).padStart(2, '0');
    return {
      id,
      title,
      category,
      price: 10 + groupIndex * 5 + index * 3.5,
      image: `${baseUrl}demo-products/${id}.jpg`,
      rating: 3.5 + ((index + groupIndex) % 4) * 0.5,
    };
  }),
);

const comments = [
  'Me pareció fácil de usar.',
  'Cumplió mis expectativas.',
  'El tamaño me resultó práctico.',
];

export const reviewsByProduct = new Map(products.map((product, index) => [
  product.id,
  comments.map((text, reviewIndex) => ({
    id: `demo-r-${product.id}-${reviewIndex + 1}`,
    user_id: sampleUserIds[(index + reviewIndex) % sampleUserIds.length],
    rating: [4, 5, 4][reviewIndex],
    text,
    profile_link: '',
  })),
]));
