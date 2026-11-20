#!/usr/bin/env bash
# Job vecinal Spark SQL: recomendaciones por usuarios con productos en común.
# Uso: ./scripts/run-neighbors.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PACKAGE="${SPARK_CASSANDRA_PACKAGE:-com.datastax.spark:spark-cassandra-connector_2.12:3.5.0}"

echo "==> Enviando job vecinal (Spark SQL) al cluster"
docker exec \
  -e HOME=/tmp \
  -e CASSANDRA_HOST="${CASSANDRA_HOST:-cassandra}" \
  -e CASSANDRA_PORT="${CASSANDRA_PORT:-9042}" \
  -e CASSANDRA_KEYSPACE="${CASSANDRA_KEYSPACE:-ecommerce_rec}" \
  -e RECOMMENDATION_LIMIT="${RECOMMENDATION_LIMIT:-10}" \
  -e SPARK_NEIGHBORS_MIN_SHARED="${SPARK_NEIGHBORS_MIN_SHARED:-1}" \
  spark-master \
  /opt/spark/bin/spark-submit \
    --master "${SPARK_MASTER_URL:-spark://spark-master:7077}" \
    --packages "$PACKAGE" \
    --conf spark.cassandra.connection.host="${CASSANDRA_HOST:-cassandra}" \
    --conf spark.cassandra.connection.port="${CASSANDRA_PORT:-9042}" \
    --conf spark.jars.ivy=/tmp/.ivy2 \
    --conf spark.driver.memory=512m \
    --conf spark.executor.memory=512m \
    --conf spark.sql.shuffle.partitions=8 \
    /opt/spark/jobs/neighbors_job.py
