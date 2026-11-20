# Guía de demostración (en la web)

Abre **http://localhost:5173** y pulsa la pestaña **«Demo en vivo»**. Todo lo que
pide la rúbrica se ve ahí, con datos consultados en el momento a los servicios
reales; no es una captura ni un script de terminal.

Las otras pestañas completan la historia: **«Catálogo y recomendaciones»** permite
buscar entre 1.000 productos por texto libre, abre el detalle con 50 reseñas, publica
eventos reales con dos botones (Spark vecinal y Grafo Neo4j) y muestra el historial
de la sesión; **«Comparativa de motores»** enfrenta solo esos dos motores;
**«Explorador de grafo Neo4j»** dibuja usuarios, productos, relaciones, contadores y
afinidad por categoría leyendo solo Neo4j; y **«Grafo en tiempo real»** construye un
grafo aparte con los eventos nuevos recibidos por SSE desde Kafka, con badge de
conexión, lista de eventos y formulario para publicar. El diseño viene de
`feature/frontend-lorena`, pero usa datos reales del backend: no hay modo simulado
ni imágenes de demostración.

El panel se actualiza solo cada 4 segundos. `scripts/demo-live.sh` queda como
apoyo opcional para mostrar los mismos datos por consola, pero **la evidencia
principal es la web**.

## Cobertura de requisitos

| Requisito | Bloque de la web | Qué se ve |
|---|---|---|
| Datos fluyendo por ≥3 componentes | Bloque 1 | Tubería **React → API → Kafka → consumidor → Cassandra + Neo4j → Spark vecinal**, con estado, latencia y contadores por componente. Al pulsar «Publicar click» los contadores aumentan y los componentes afectados se resaltan en ámbar. |
| Grafo persistido y grafo en vivo separados | Pestañas «Explorador de grafo Neo4j» y «Grafo en tiempo real» | El primero consulta solo `/api/graph/neo4j/:userId`; el segundo recibe `/api/stream/events` (SSE) desde un consumidor Kafka dedicado y dibuja los eventos nuevos sin consultar Neo4j. |
| Consulta en vivo con resultado visible y explicado | Bloque 2 | Pestañas **CQL**, **Cypher** y **Vecinos Spark**: se muestra la consulta ejecutada, las filas devueltas, su latencia y una explicación debajo de cada resultado. |
| Evidencia de escala | Bloque 3 | 1.000 productos, 500.000 filas leídas, 50.000 en reservorio, 50 reseñas por producto (50.000 asignadas) y ~37 s de ingesta, además de los conteos en vivo; tabla comparativa **Spark vecinal vs Grafo Neo4j** con ítems, latencia, cobertura y motor más rápido. |
| Datos grandes precargados | Bloque 3 | Los 500k registros se procesaron antes de la exposición desde `data/reviews.csv`. En vivo solo se publica un evento y se ejecutan consultas; la ingesta jamás se hace durante la demo. |
| Servicios en la nube activos y verificados | Bloque 4 | `HeadObject` real a `s3://duvan-lorena/raw/aws-database.csv` con el perfil AWS del host: badge «S3 accesible», bucket, objeto, tamaño (310,9 MB), fecha, región/perfil, latencia y hora de verificación. |

## Guion sugerido (5 minutos)

1. **Nube (30 s)** — bloque 4: mostrar el `HeadObject` verificado antes de empezar.
2. **Flujo (2 min)** — bloque 1: pulsar «Publicar click» (o hacer clic en un producto del catálogo). Señalar cómo cambian los contadores de Kafka, Cassandra y Neo4j y cómo se resaltan los componentes. Eso son cinco componentes, no tres. Antes, en el catálogo, buscar «lego» o «laptop» y abrir un producto para mostrar sus 50 reseñas.
3. **Consultas (2 min)** — bloque 2: recorrer CQL (partición por `user_id`), Cypher (`MERGE` del grafo) y **Vecinos Spark** (co-ocurrencia con `neighbor_count` y `shared_products`, recalculada en vivo si hay clics nuevos).
4. **Dos grafos (1 min)** — pestaña «Explorador de grafo Neo4j»: selecciona un producto y muestra sus relaciones y la consulta Cypher ejecutada. Después abre «Grafo en tiempo real», publica un clic con el formulario (o desde el catálogo) y señala cómo aparece el nuevo nodo/arista y el evento con su offset, sin recargar ni consultar Neo4j.
5. **Escala (30 s)** — bloque 3: 500k filas ya cargadas, 1.000 productos y 50 reseñas por producto, comparación de latencias y cobertura entre Spark vecinal y Neo4j.

## Perfil nuevo en tiempo real

En la pestaña «Catálogo y recomendaciones», cambia el usuario por uno nuevo
(por ejemplo `demo_<tu_nombre>`) y haz clic en productos. El motor por defecto
es **Spark vecinal**: pasa a `Vecinal en vivo` (`spark-neighbors-online`) y
reacciona a cada clic sin reenviar el job. El botón «Grafo Neo4j» permite
comparar el mismo vecindario en el grafo. La pestaña «Demo en vivo» muestra
después las consultas y el flujo de ese mismo usuario.

## Si algo falla

- Algún componente en rojo en el bloque 1 → revisar `docker ps` y los logs de ese contenedor.
- `cold-start` en una consulta `?engine=spark` → falta ejecutar `./scripts/run-spark.sh` para exportar `als_item_factors`. La web no usa ese motor: con perfiles nuevos debe ver `Vecinal en vivo` (`spark-neighbors-online`).
- Sin filas en «Vecinos Spark» → ejecutar `./scripts/run-neighbors.sh` (el panel recalcula en vivo para perfiles con eventos, pero la tabla precargada se llena con ese job). Si cambiaste el catálogo, repite también `./scripts/run-spark.sh` y la ingesta; de lo contrario las recomendaciones pueden apuntar a productos descartados.
- «Sin acceso» en el bloque 4 → revisar `AWS_PROFILE` y el montaje de `~/.aws` en `docker-compose.app.yml`.
- `Exited (137)` en Cassandra → OOM; bajar `CASSANDRA_MAX_HEAP` en `.env`. No lanzar dos jobs ALS a la vez.
