#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "No existe .env. Copia la plantilla y ajusta tus credenciales:"
  echo "  cp .env.example .env"
  exit 1
fi

echo "==> Levantando infraestructura (Zookeeper, Kafka, Cassandra, Spark, Neo4j)"
docker compose -f docker-compose.yml up -d --build

echo "==> Construyendo y levantando backend, consumidor y frontend"
docker compose -f docker-compose.app.yml up -d --build

echo "==> Esperando a Kafka, Cassandra y Neo4j"
docker compose -f docker-compose.app.yml run --rm backend npm run wait

echo "==> Creando keyspace/tablas y constraints del grafo"
docker compose -f docker-compose.app.yml run --rm backend npm run init:cassandra
docker compose -f docker-compose.app.yml run --rm backend npm run init:neo4j

echo "==> Cruzando 1000 productos del catálogo con 50 reseñas aleatorias por producto"
docker compose -f docker-compose.app.yml run --rm backend npm run ingest

echo "==> Calculando recomendaciones con Spark ALS"
./scripts/run-spark.sh

echo "==> Calculando recomendaciones vecinales con Spark SQL"
./scripts/run-neighbors.sh

echo "Listo. Frontend: http://localhost:${FRONTEND_PORT:-5173} · API: http://localhost:${BACKEND_PORT:-4000}/api/health"
