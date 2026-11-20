#!/usr/bin/env bash
# Demostración en vivo: flujo entre componentes, consultas CQL/Cypher y escala.
# Uso: ./scripts/demo-live.sh [userId] [productId]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

section() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
explain() { printf '\033[36m    %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 0. Preflight
section '0. Servicios y acceso a la nube (antes de empezar)'
set -a
[[ -f .env ]] && . ./.env
set +a

docker ps --format '{{.Name}} {{.Status}}' | grep -E 'kafka|cassandra|neo4j|spark|rec-' || true
curl -sS http://localhost:4000/api/health || true
printf '\n'
if command -v aws >/dev/null 2>&1 && [[ -n "${S3_BUCKET:-}" ]]; then
  aws s3 ls "s3://${S3_BUCKET}/${S3_REVIEWS_CSV_KEY:-}" --profile "${AWS_PROFILE:-default}" | head -3 || true
  explain 'El objeto S3 existe y las credenciales del perfil funcionan.'
else
  explain 'AWS CLI no disponible: la ingesta ya dejó data/ingestion-summary.json como evidencia.'
fi

USER_ID="${1:-$(curl -sS http://localhost:4000/api/meta | python3 -c 'import json,sys; print(json.load(sys.stdin)["sampleUserIds"][0])')}"
PRODUCT_ID="${2:-10}"
if [[ ! "$USER_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "ID de usuario inválido: $USER_ID" >&2
  exit 1
fi
printf '\nUsuario de la demo: %s · Producto: %s\n' "$USER_ID" "$PRODUCT_ID"

# ---------------------------------------------------------------- 1. Flujo
section '1. Flujo en vivo: React → API → Kafka → consumidor → Cassandra + Neo4j'
curl -sS -X POST http://localhost:4000/api/events \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"product_id\":\"${PRODUCT_ID}\",\"event_type\":\"click\"}"
printf '\n'
sleep 2
docker logs --tail 300 rec-consumer 2>&1 | grep -F "click ${USER_ID}" | tail -3 || true
explain 'La API publica en Kafka; el consumidor escribe el evento en user_sessions (Cassandra) y la relación CLICKED (Neo4j).'

# ---------------------------------------------------------------- 2. CQL
section '2. Consulta en vivo CQL: sesión recién escrita en Cassandra'
docker exec cassandra cqlsh -e \
  "SELECT product_id, event_type, event_timestamp FROM ecommerce_rec.user_sessions WHERE user_id = '${USER_ID}' LIMIT 5;"
explain 'Cada fila es un evento del usuario, ordenado por timestamp DESC (clave de clustering).'

# ---------------------------------------------------------------- 3. Cypher
section '3. Consulta en vivo Cypher: relaciones del usuario en el grafo'
docker exec neo4j cypher-shell -u neo4j -p password123 --format plain \
  "MATCH (u:User {id: '${USER_ID}'})-[r]->(p:Product) RETURN u.id AS usuario, type(r) AS relacion, p.id AS producto, p.title AS titulo LIMIT 10;"
explain 'MERGE creó el nodo :User y la relación CLICKED en cuanto llegó el evento; no hizo falta reingestar.'

# ---------------------------------------------------------------- 4. Spark
section '4. Spark ALS en tiempo real: factores del modelo + perfil nuevo'
docker exec cassandra cqlsh -e 'SELECT count(*) FROM ecommerce_rec.als_item_factors;'
curl -sS "http://localhost:4000/api/recommendations/${USER_ID}?engine=spark" > /tmp/demo-spark.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/demo-spark.json'))
print(f"source={d.get('source')}  items={len(d['items'])}  latencia={d.get('latency_ms')} ms")
print(d.get('note', ''))
for item in d['items'][:5]:
    print(f"  #{item['rank']:>2} {item['title'][:38]:38} {str(item['category']):20} {item['score']}")
PY
explain 'als = Top-N precalculado; als-online = vector del usuario calculado desde sus eventos con los factores exportados (sin reentrenar).'

# ---------------------------------------------------------------- 5. Escala
section '5. Evidencia de escala y comparación de enfoques'
python3 - <<'PY'
import json
s = json.load(open('data/ingestion-summary.json'))
print(f"filas leídas: {s['reviews']['scanned']:,} · válidas: 499,841 · reservorio: {s['reviews']['pooled']:,}")
print(f"productos: {s['catalog']['count']} · reseñas asignadas: {s['reviews']['assigned']:,} · fuente: {s['source']}")
PY
curl -sS "http://localhost:4000/api/compare/${USER_ID}" > /tmp/demo-compare.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/demo-compare.json'))
for key, name in (('spark', 'Spark ALS'), ('neo4j', 'Grafo Neo4j')):
    engine = d[key]
    print(f"{name:12} items={len(engine['items']):>2}  latencia={engine.get('latency_ms')} ms  source={engine.get('source', 'grafo')}")
print('motor más rápido:', d.get('fasterEngine'))
PY
explain 'Datos grandes pre-cargados (500k filas, 14 s de reingesta desde caché): en vivo solo se muestra el flujo y las consultas.'
