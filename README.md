# Motor de Recomendación Reactivo — Reto 2

Motor de recomendación para e-commerce que combina un catálogo de **1.000 productos reales** (CSV público de Best Buy), **50 reseñas del dataset de 500.000 por producto** y eventos de navegación en tiempo casi real publicados desde React. El catálogo se puede buscar por texto libre. La interfaz compara dos motores: **Spark vecinal** (co-ocurrencia explicable) y **Neo4j** (filtrado colaborativo en grafo), con latencia medida en el backend. El job ALS sigue disponible en el backend (`?engine=spark`) pero no se muestra en la web.

```
React (Vite)  ──POST /api/events──▶  Express ──▶ Kafka (user-navigation-events)
     │                                   │                │
     │ GET /api/products                 │                ▼
     │ GET /api/recommendations          │         Consumidor Kafka
     ▼                                   ▼                ├─▶ Cassandra.user_sessions
Cassandra (catálogo, reseñas, recs)  Neo4j (consulta) └─▶ Neo4j (:CLICKED/:VIEWED/:PURCHASED)
                                          ▲
S3 (.zip 500k reseñas) ─▶ script ingesta ─┘
                              │
                              └─▶ Spark vecinal ─▶ Cassandra.recommendations_spark_neighbors
```

## Estructura

| Ruta | Responsabilidad |
| --- | --- |
| `docker-compose.yml` | Infraestructura: Zookeeper, Kafka, Cassandra, Spark master/worker, Neo4j |
| `docker-compose.app.yml` | Aplicación: backend Express, consumidor Kafka, frontend React |
| `backend/src/server.js` | API REST y publicación de eventos en Kafka |
| `backend/src/consumer.js` | Consumo Kafka → Cassandra + Neo4j |
| `backend/src/scripts/ingest.js` | CSV de 1.000 productos + 50 reseñas aleatorias por producto (S3 o CSV local) |
| `backend/src/scripts/product-utils.js` | Normalización del CSV de productos y búsqueda de texto libre |
| `backend/src/scripts/init-*.js` | DDL de Cassandra y constraints de Neo4j |
| `backend/src/services/recommendations.js` | Consultas a ambos motores, latencia y comparativa |
| `backend/src/services/graph.js` | Consultas Cypher para el explorador persistido (nodos, aristas y estadísticas) |
| `backend/src/services/event-stream.js` | Consumidor fan-out de Kafka y suscripción SSE para el grafo en tiempo real |
| `spark/jobs/als_job.py` | ALS sobre reseñas + sesiones → `recommendations_spark` (backend, oculto en la UI) |
| `spark/jobs/neighbors_job.py` | Co-ocurrencia Spark sobre reseñas + sesiones del catálogo vigente → `recommendations_spark_neighbors` |
| `frontend/src/` | Catálogo, detalle con reseñas, eventos reactivos, comparativa, explorador Neo4j, grafo en vivo, historial de sesión y demo en vivo |
| `scripts/` | Arranque, job Spark y apagado |

## Puesta en marcha

```bash
cp .env.example .env      # ajusta S3_BUCKET, S3_REVIEWS_CSV_KEY (o ZIP) y AWS_PROFILE
./scripts/bootstrap.sh
```

`bootstrap.sh` levanta todo, espera a los servicios, crea el esquema, ejecuta la ingesta (1.000 productos y 50.000 reseñas asignadas) y lanza los jobs vecinal y ALS de Spark.

URLs:

- Frontend: http://localhost:5173
- API: http://localhost:4000/api/health
- Spark UI: http://localhost:8080
- Neo4j Browser: http://localhost:7474

La web tiene cinco pestañas: **«Catálogo y recomendaciones»**, **«Comparativa de motores»**,
**«Explorador de grafo Neo4j»**, **«Grafo en tiempo real»** y **«Demo en vivo»**. El diseño
responsive y los paneles de grafo, flujo e historial se incorporaron de `feature/frontend-lorena`,
pero conectados a los datos reales del backend (sin modo simulado ni imágenes de demostración).

- **Catálogo y recomendaciones:** barra de búsqueda de texto libre (título, categoría,
  marca y descripción; sin acentos, palabras AND, resultados paginados), 1.000 productos
  con imagen real y fallback, detalle con 50 reseñas y dos botones —Spark vecinal y
  Grafo Neo4j— que se envuelven en pantallas estrechas. El panel de «Interacciones
  recientes» muestra los eventos publicados en esta pestaña del navegador.
- **Comparativa de motores:** dos tarjetas (Spark vecinal y Neo4j) con latencia,
  cobertura, vecinos y coincidencias; guía de ranking y estado de petición por usuario.
- **Explorador de grafo Neo4j:** nodos SVG del usuario y sus productos, contadores por tipo
  de relación, afinidad por categoría, consulta Cypher ejecutada y selección accesible de
  nodos. Todos los datos (incluidas las estadísticas) vienen de `/api/graph/neo4j/:userId`,
  sin mezclar actividad local del navegador ni filas de Cassandra.
- **Grafo en tiempo real:** panel separado alimentado por `GET /api/stream/events` (SSE).
  Un consumidor Kafka propio del backend, con grupo distinto al de `rec-consumer` y offset
  inicial más reciente, reenvía cada mensaje `user-navigation-events` al navegador. El panel
  construye usuarios, productos y aristas solo con eventos nuevos, muestra estado de conexión,
  contadores, lista de eventos con offset y un formulario para publicar eventos reales.
- **Demo en vivo:** contra los servicios reales y con auto-refresh de 4 s: el flujo
  React → API → Kafka → consumidor → Cassandra + Neo4j + Spark, consultas
  CQL/Cypher/Spark con resultado y explicación, evidencia de escala (500k filas
  precargadas y comparativa Spark vecinal vs Grafo) y un `HeadObject` a S3 que
  acredita el acceso. Sus endpoints son `/api/demo/flow`,
  `/api/demo/queries/:userId`, `/api/demo/scale/:userId` y `/api/demo/cloud`.
  Guion en [DEMO.md](DEMO.md).

Para detener sin perder datos (volúmenes persistentes): `./scripts/stop.sh`.
Para repetir los jobs: `./scripts/run-neighbors.sh` (motor visible) y `./scripts/run-spark.sh` (ALS, solo backend). Tras cambiar el catálogo hay que volver a ejecutar ambos para que las recomendaciones no apunten a productos antiguos.

### Configuración del dataset en S3

El script de ingesta resuelve la fuente en este orden:

1. `REVIEWS_CSV_PATH` si el archivo existe localmente (por defecto `data/reviews.csv`).
2. `s3://S3_BUCKET/S3_REVIEWS_CSV_KEY` si el CSV ya está extraído.
3. `s3://S3_BUCKET/S3_REVIEWS_ZIP_KEY`: descarga el `.zip`, extrae el CSV más grande y lo guarda en `data/`.
4. Si `ALLOW_SYNTHETIC_REVIEWS=true`, genera un dataset sintético pequeño para desarrollo.

Credenciales: se usan `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, el `AWS_PROFILE` del entorno o el rol por defecto de AWS. Si tus credenciales viven en `~/.aws/credentials` del host, `docker-compose.app.yml` monta esa carpeta como solo lectura en `/root/.aws` y `.env` usa `AWS_PROFILE=default`; no hace falta copiar secretos al `.env`. Para MinIO, define `S3_ENDPOINT` y `S3_FORCE_PATH_STYLE=true`.

La primera ingesta guarda el CSV descargado en `data/reviews.csv`, que queda como caché local para ejecuciones posteriores.

El CSV se lee **por streaming** con un reservorio acotado (`REVIEW_POOL_SIZE`, 50.000 por defecto) y `RANDOM_SEED` fijo: se recorren las 500.000 filas una sola vez, se muestrean 50.000 reseñas válidas y se reparten 50 reseñas distintas a cada uno de los 1.000 productos (50.000 asignaciones) sin cargar el dataset completo en memoria ni enviarlo al navegador. La ingesta actual tardó ~37 s y trunca catálogo, reseñas y relaciones `REVIEWED` para que no queden productos de corridas anteriores.

Detección de columnas: por alias (`Rating`, `Profile Link`, `Review Text`, …) o mediante `REVIEWS_COL_*` en `.env`. El rating `"Rated 4 out of 5 stars"` se convierte a `4.0` y el `user_id` se normaliza desde el último segmento del Profile Link para que coincida en Cassandra, Spark y Neo4j.

## API REST

| Método | Endpoint | Descripción |
| --- | --- | --- |
| GET | `/api/health` | Estado del servicio |
| GET | `/api/meta` | Usuarios de ejemplo e información de la ingesta |
| GET | `/api/products?limit=12&cursor=<id>&q=<texto>` | Catálogo paginado por cursor; `q` filtra por texto libre y devuelve `total` |
| GET | `/api/products/:id/reviews?limit=50` | Las 50 reseñas del producto |
| POST | `/api/events` | Publica `{user_id, product_id, event_type, timestamp}` en Kafka (`view`, `click`, `purchase`) |
| GET | `/api/recommendations/:userId?engine=spark-neighbors\|neo4j\|spark` | Recomendaciones + `latency_ms` (`spark` = ALS, solo backend) |
| GET | `/api/compare/:userId` | Ambos motores, latencias y observaciones de calidad |

Ejemplo:

```bash
curl -X POST http://localhost:4000/api/events \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"demo_tu_nombre","product_id":"6548464","event_type":"click"}'

curl 'http://localhost:4000/api/products?q=lego&limit=12'
curl 'http://localhost:4000/api/recommendations/u_65ee5eb0c64a540012541730?engine=spark-neighbors'
```

## Diseño de Cassandra (por consulta)

Keyspace `ecommerce_rec`, `SimpleStrategy` / RF=1 (reto local).

| Tabla | Clave de partición | Clustering | Consulta que resuelve |
| --- | --- | --- | --- |
| `products` | `product_id` | — | Detalle por id |
| `products_by_catalog` | `catalog_key` (`default`) | `product_id ASC` | Catálogo paginado por cursor en una sola partición |
| `product_reviews` | `product_id` | `review_id ASC` | Las 50 reseñas de un producto en una lectura |
| `user_sessions` | `user_id` | `event_timestamp DESC` | Historial reciente del usuario |
| `recommendations_spark` | `user_id` | `rank ASC` | Top-N ALS precalculado, lectura secuencial (oculto en la UI) |
| `recommendations_spark_neighbors` | `user_id` | `rank ASC` | Top-N vecinal precalculado, lectura secuencial |

El consumidor ajusta timestamps duplicados en el mismo milisegundo (`último + 1 ms`) para que dos eventos rápidos no se sobrescriban dentro de la misma clave de clustering.

## Grafo Neo4j

Nodos `:User {id}` y `:Product {id, title, category, price}`, con relaciones `:REVIEWED` (ingesta) y `:VIEWED`, `:CLICKED`, `:PURCHASED` (eventos Kafka). La consulta colaborativa:

```cypher
MATCH (u:User {id: $userId})-->(seen:Product)
WITH u, collect(DISTINCT seen.id) AS seen
MATCH (u)-->(shared:Product)<--(other:User)
WHERE other.id <> u.id
WITH DISTINCT u, seen, other
MATCH (other)-->(rec:Product)
WHERE NOT rec.id IN seen
RETURN rec.id, rec.title, rec.category, count(DISTINCT other.id) AS score
ORDER BY score DESC LIMIT $limit
```

El explorador persistido usa `/api/graph/neo4j/:userId`, que solo lee estos nodos y relaciones. El explorador en vivo usa `GET /api/stream/events`: el backend mantiene un consumidor Kafka dedicado con grupo propio y reenvía cada evento por SSE; el navegador dibuja ese flujo sin consultar Neo4j. Así quedan separadas la evidencia persistida y la reacción inmediata al evento.

## Spark ALS (job disponible, oculto en la interfaz)

> Nota: la interfaz solo expone el motor vecinal y Neo4j. Las secciones de ALS se
> conservan porque el job y el modo online siguen disponibles en el backend vía
> `?engine=spark`; no aparecen en botones, tarjetas ni pestañas de la web.

`spark/jobs/als_job.py` une reseñas (rating 1–5) y sesiones (`view=1`, `click=2.5`, `purchase=5`) como interacciones **filtradas a los 1.000 productos del catálogo vigente**, entrena ALS (`rank`, `iteraciones` y `regParam` parametrizables), descarta ítems ya vistos con `left_anti`, añade metadatos del producto y sobrescribe `recommendations_spark`. También exporta los vectores latentes de los productos a `als_item_factors` para poder recomendar a perfiles nuevos sin reentrenar. Si hay menos de 2 usuarios o 2 productos, usa un fallback de popularidad/co-ocurrencia.

El job se envía al cluster con `spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0` y el conector se distribuye a los executors automáticamente.

### Perfiles nuevos: ALS en tiempo real (fold-in)

El Top-N de `recommendations_spark` es batch, pero los **factores de los productos** no lo son. `backend/src/services/recommendations.js` resuelve tres casos:

1. El usuario está en el Top-N precalculado → se devuelve (`"source": "als"`).
2. No está, pero hay factores exportados → **ALS online** (`"source": "als-online"`): se leen los últimos eventos del usuario en `user_sessions`, se construye su vector latente como media ponderada de los factores de los productos interactuados (`view=1`, `click=2.5`, `purchase=5`) y se puntúa todo el catálogo por producto escalar. Se recalcula en cada petición, así que **cada clic cambia las recomendaciones al instante**, sin reentrenar.
3. Todavía no hay factores (job no ejecutado) → fallback por categorías exploradas y rating (`"source": "cold-start"`), con `COLD_START_CATEGORY_BOOST=2` por defecto.

Tras `./scripts/run-spark.sh`, los perfiles nuevos con eventos pasan automáticamente a `als-online` si se consulta `?engine=spark`. Se puede desactivar con `ALS_ONLINE_ENABLED=false`; el último recurso con `COLD_START_ENABLED=false`. En la web el perfil nuevo usa `spark-neighbors-online`, no ALS.

### Motor vecinal Spark (equivalente a Neo4j)

`spark/jobs/neighbors_job.py` (lanzado con `./scripts/run-neighbors.sh`) calcula **co-ocurrencia sobre reseñas y sesiones del catálogo vigente** con Spark SQL: dos usuarios son vecinos si interactuaron con los mismos productos, y recomienda productos de esos vecinos que el usuario aún no vio. Las reseñas aportan 16.396 usuarios y 12.208 con más de un producto; los eventos de demostraciones anteriores que apuntan a productos descartados se ignoran. Con la ingesta actual se generaron ~1,2 M de pares de vecinos y 163.960 recomendaciones. Es la misma idea del grafo, pero en Spark, y escribe `recommendations_spark_neighbors` con `neighbor_count`, `shared_products` y `example_neighbor` para que cada recomendación sea explicable.

El backend expone este motor en `GET /api/recommendations/:userId?engine=spark-neighbors`:

- `spark-neighbors` → Top-N del job.
- `spark-neighbors-online` → si el perfil es nuevo o tiene eventos más recientes que el job, se recalcula la co-ocurrencia en el backend sobre Cassandra (`source: spark-neighbors-online`). Reacciona a cada clic sin reenviar el job, igual que Neo4j.

Es el motor por defecto del panel «Recomendaciones» y aparece junto a Neo4j en la comparativa (dos tarjetas), en el explorador de grafo (al consultar las relaciones de Cypher) y como pestaña «Vecinos · Spark» en la demo web. La interfaz solo expone estos dos motores; los botones se adaptan a pantallas estrechas apilándose y ocupando todo el ancho disponible. El diseño de `feature/frontend-lorena` también aportó guías de ranking, fallback de imágenes y estilos responsive validados a 390 px.

## Comparativa y métricas

`getRecommendations` y `getComparison` envuelven cada consulta con `performance.now()` y devuelven `latency_ms`. La vista comparativa muestra:

- Lista de ítems y score de cada motor.
- Latencia de cada consulta y motor más rápido.
- Cobertura (`ítems devueltos / límite`).
- Spark vecinal: usuarios vecinos y solapamiento con los últimos clics del usuario.
- Neo4j: usuarios vecinos y solapamiento con los últimos clics del usuario.

Calidad esperada: el motor vecinal de Spark y el grafo reaccionan de inmediato y explican cada ítem por usuarios con productos en común. Ambos leen interacciones reales: las reseñas del dataset (50 por producto) y los eventos de `user_sessions`. ALS (oculto en la UI) comprime la señal en 10 factores latentes y no ofrece una ruta explicable; en este dataset las reseñas se asignaron aleatoriamente a los productos, por lo que captura menos estructura por categoría.

## Verificación rápida

```bash
curl 'http://localhost:4000/api/meta'
curl 'http://localhost:4000/api/products?q=lapto&limit=12'
docker exec cassandra cqlsh -e "SELECT product_id, title FROM ecommerce_rec.products LIMIT 5;"
docker exec neo4j cypher-shell -u neo4j -p password123 \
  "MATCH (u:User)-[r:REVIEWED]->(p:Product) RETURN count(r) AS relaciones;"
docker exec kafka kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic user-navigation-events --from-beginning --max-messages 5
```

## Solución de problemas

- **Recomendaciones vacías para un usuario escrito a mano**: Spark solo calcula para usuarios presentes en reseñas/sesiones al entrenar; genera eventos y vuelve a ejecutar `./scripts/run-neighbors.sh` (y `./scripts/run-spark.sh` si consultas `?engine=spark`). En Neo4j el primer evento crea el nodo `:User` automáticamente, pero se necesita otro usuario con productos compartidos para encontrar vecinos.
- **Sin reseñas en la ingesta**: revisa `REVIEWS_CSV_PATH` o `S3_*` y ejecuta `docker compose -f docker-compose.app.yml run --rm backend npm run ingest`.
- **`No se pudo descargar s3://...`**: comprueba que la clave exista (`aws s3 ls s3://TU_BUCKET --recursive`), que `AWS_PROFILE` sea correcto y que `~/.aws` esté accesible para el montaje del contenedor `backend`. El error concreto de S3 se incluye al final del mensaje.
- **`recommendations_spark` vacía**: ejecuta `./scripts/run-spark.sh`; revisa los logs con `docker logs spark-master`. El job trunca la tabla antes de escribir: si se interrumpe (por ejemplo, si Cassandra muere), esa tabla queda vacía y la API usa `als-online` (o `cold-start` si tampoco hay factores). Vuelve a ejecutar el job para repoblar ambas tablas.
- **Errores 500 en `/api/products` y `Unknown host 'cassandra'` en Spark**: Cassandra está caído (`docker ps` muestra `Exited (137)`, OOM). En equipos con poca memoria baja `CASSANDRA_MAX_HEAP`, `NEO4J_HEAP`/`NEO4J_PAGECACHE` y `SPARK_DAEMON_MEMORY` en `.env`, y levanta de nuevo con `docker compose -f docker-compose.yml up -d`. No lances dos jobs ALS a la vez: el pico de memoria puede matar a Cassandra. Los datos sobreviven porque están en el volumen `cassandra_data`.
- **El explorador Neo4j no se actualiza**: comprueba que `rec-consumer` esté activo (`docker logs rec-consumer`) y pulsa «Actualizar» en el panel.
- **El grafo en tiempo real no recibe eventos**: revisa `curl -N http://localhost:4000/api/stream/events`, que el backend muestre `Fan-out SSE activo` en sus logs y que no haya un proxy intermedio bufferizando la respuesta. El stream arranca en el offset más reciente, así que solo aparecen eventos publicados después de abrir la conexión.
- **Latencia alta en Neo4j**: reduce `RECOMMENDATION_LIMIT` o limita el grado de los vecinos en la consulta Cypher.
- **Kafka no arranca con `InconsistentClusterIdException`**: los volúmenes `kafka_data`/`zookeeper_data` pertenecen a otro cluster. En un entorno de prueba, `docker compose -f docker-compose.yml down -v` y vuelve a arrancar (esto borra los datos locales).
