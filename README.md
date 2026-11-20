# Motor de Recomendación Reactivo — Reto 2

Motor de recomendación para e-commerce que combina un catálogo de API pública, reseñas históricas en Amazon S3 y eventos de navegación en tiempo casi real publicados desde React. Compara dos motores: **Spark ALS** (patrones latentes) y **Neo4j** (filtrado colaborativo en grafo), con latencia medida en el backend.

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
                              └─▶ Spark ALS ─▶ Cassandra.recommendations_spark
```

## Estructura

| Ruta | Responsabilidad |
| --- | --- |
| `docker-compose.yml` | Infraestructura: Zookeeper, Kafka, Cassandra, Spark master/worker, Neo4j |
| `docker-compose.app.yml` | Aplicación: backend Express, consumidor Kafka, frontend React |
| `backend/src/server.js` | API REST y publicación de eventos en Kafka |
| `backend/src/consumer.js` | Consumo Kafka → Cassandra + Neo4j |
| `backend/src/scripts/ingest.js` | Cruce API productos + 20 reseñas aleatorias por producto (S3 o CSV local) |
| `backend/src/scripts/init-*.js` | DDL de Cassandra y constraints de Neo4j |
| `backend/src/services/recommendations.js` | Consultas a ambos motores, latencia y comparativa |
| `spark/jobs/als_job.py` | ALS sobre reseñas + sesiones → `recommendations_spark` |
| `frontend/src/` | Catálogo, detalle con reseñas, eventos reactivos y panel comparativo |
| `scripts/` | Arranque, job Spark y apagado |

## Puesta en marcha

```bash
cp .env.example .env      # ajusta S3_BUCKET, S3_REVIEWS_CSV_KEY (o ZIP) y AWS_PROFILE
./scripts/bootstrap.sh
```

`bootstrap.sh` levanta todo, espera a los servicios, crea el esquema, ejecuta la ingesta y lanza el job de Spark.

URLs:

- Frontend: http://localhost:5173
- API: http://localhost:4000/api/health
- Spark UI: http://localhost:8080
- Neo4j Browser: http://localhost:7474

Para detener sin perder datos (volúmenes persistentes): `./scripts/stop.sh`.
Para repetir solo Spark: `./scripts/run-spark.sh`.

### Configuración del dataset en S3

El script de ingesta resuelve la fuente en este orden:

1. `REVIEWS_CSV_PATH` si el archivo existe localmente (por defecto `data/reviews.csv`).
2. `s3://S3_BUCKET/S3_REVIEWS_CSV_KEY` si el CSV ya está extraído.
3. `s3://S3_BUCKET/S3_REVIEWS_ZIP_KEY`: descarga el `.zip`, extrae el CSV más grande y lo guarda en `data/`.
4. Si `ALLOW_SYNTHETIC_REVIEWS=true`, genera un dataset sintético pequeño para desarrollo.

Credenciales: se usan `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, el `AWS_PROFILE` del entorno o el rol por defecto de AWS. Si tus credenciales viven en `~/.aws/credentials` del host, `docker-compose.app.yml` monta esa carpeta como solo lectura en `/root/.aws` y `.env` usa `AWS_PROFILE=default`; no hace falta copiar secretos al `.env`. Para MinIO, define `S3_ENDPOINT` y `S3_FORCE_PATH_STYLE=true`.

La primera ingesta guarda el CSV descargado en `data/reviews.csv`, que queda como caché local para ejecuciones posteriores.

El CSV se lee **por streaming** con un reservorio acotado (`REVIEW_POOL_SIZE`, 4000 por defecto) y `RANDOM_SEED` fijo: se recorren las 500.000 filas una sola vez y se reparten 20 reseñas distintas a cada producto sin cargar el dataset completo en memoria ni enviarlo al navegador.

Detección de columnas: por alias (`Rating`, `Profile Link`, `Review Text`, …) o mediante `REVIEWS_COL_*` en `.env`. El rating `"Rated 4 out of 5 stars"` se convierte a `4.0` y el `user_id` se normaliza desde el último segmento del Profile Link para que coincida en Cassandra, Spark y Neo4j.

## API REST

| Método | Endpoint | Descripción |
| --- | --- | --- |
| GET | `/api/health` | Estado del servicio |
| GET | `/api/meta` | Usuarios de ejemplo e información de la ingesta |
| GET | `/api/products?limit=12&cursor=<id>` | Catálogo paginado por cursor |
| GET | `/api/products/:id/reviews?limit=20` | Las 20 reseñas del producto |
| POST | `/api/events` | Publica `{user_id, product_id, event_type, timestamp}` en Kafka (`view`, `click`, `purchase`) |
| GET | `/api/recommendations/:userId?engine=spark\|neo4j` | Recomendaciones + `latency_ms` |
| GET | `/api/compare/:userId` | Ambos motores, latencias y observaciones de calidad |

Ejemplo:

```bash
curl -X POST http://localhost:4000/api/events \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"u_amzn1.account.abc-123","product_id":"1","event_type":"click"}'

curl 'http://localhost:4000/api/recommendations/u_amzn1.account.abc-123?engine=neo4j'
```

## Diseño de Cassandra (por consulta)

Keyspace `ecommerce_rec`, `SimpleStrategy` / RF=1 (reto local).

| Tabla | Clave de partición | Clustering | Consulta que resuelve |
| --- | --- | --- | --- |
| `products` | `product_id` | — | Detalle por id |
| `products_by_catalog` | `catalog_key` (`default`) | `product_id ASC` | Catálogo paginado por cursor en una sola partición |
| `product_reviews` | `product_id` | `review_id ASC` | Las 20 reseñas de un producto en una lectura |
| `user_sessions` | `user_id` | `event_timestamp DESC` | Historial reciente del usuario |
| `recommendations_spark` | `user_id` | `rank ASC` | Top-N precalculado, lectura secuencial |

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

## Spark ALS

`spark/jobs/als_job.py` une reseñas (rating 1–5) y sesiones (`view=1`, `click=2.5`, `purchase=5`) como interacciones, entrena ALS (`rank`, `iteraciones` y `regParam` parametrizables), descarta ítems ya vistos con `left_anti`, añade metadatos del producto y sobrescribe `recommendations_spark`. Si hay menos de 2 usuarios o 2 productos, usa un fallback de popularidad/co-ocurrencia.

El job se envía al cluster con `spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0` y el conector se distribuye a los executors automáticamente.

## Comparativa y métricas

`getRecommendations` y `getComparison` envuelven cada consulta con `performance.now()` y devuelven `latency_ms`. La vista comparativa muestra:

- Lista de ítems y score de cada motor.
- Latencia de cada consulta y motor más rápido.
- Cobertura (`ítems devueltos / límite`).
- Spark: edad del modelo y advertencia de re-entrenamiento.
- Neo4j: usuarios vecinos y solapamiento con los últimos clics del usuario.

Calidad esperada: Spark explica patrones latentes y es estable en latencia, pero solo reacciona a nuevos eventos tras re-entrenar; el grafo reacciona de inmediato a los clics y su recomendación se explica por cercanía de grafo, con coste creciente según el grado de los nodos.

## Verificación rápida

```bash
docker exec cassandra cqlsh -e "SELECT product_id, title FROM ecommerce_rec.products LIMIT 5;"
docker exec neo4j cypher-shell -u neo4j -p password123 \
  "MATCH (u:User)-[r:REVIEWED]->(p:Product) RETURN count(r) AS relaciones;"
docker exec kafka kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic user-navigation-events --from-beginning --max-messages 5
```

## Solución de problemas

- **Recomendaciones vacías para un usuario escrito a mano**: Spark solo calcula para usuarios presentes en reseñas/sesiones al entrenar; genera eventos y vuelve a ejecutar `./scripts/run-spark.sh`. En Neo4j el primer evento crea el nodo `:User` automáticamente, pero se necesita otro usuario con productos compartidos para encontrar vecinos.
- **Sin reseñas en la ingesta**: revisa `REVIEWS_CSV_PATH` o `S3_*` y ejecuta `docker compose -f docker-compose.app.yml run --rm backend npm run ingest`.
- **`No se pudo descargar s3://...`**: comprueba que la clave exista (`aws s3 ls s3://TU_BUCKET --recursive`), que `AWS_PROFILE` sea correcto y que `~/.aws` esté accesible para el montaje del contenedor `backend`. El error concreto de S3 se incluye al final del mensaje.
- **`recommendations_spark` vacía**: ejecuta `./scripts/run-spark.sh`; revisa los logs con `docker logs spark-master`.
- **El grafo no reacciona**: comprueba que el contenedor `rec-consumer` esté activo (`docker logs rec-consumer`).
- **Latencia alta en Neo4j**: reduce `RECOMMENDATION_LIMIT` o limita el grado de los vecinos en la consulta Cypher.
- **Kafka no arranca con `InconsistentClusterIdException`**: los volúmenes `kafka_data`/`zookeeper_data` pertenecen a otro cluster. En un entorno de prueba, `docker compose -f docker-compose.yml down -v` y vuelve a arrancar (esto borra los datos locales).
