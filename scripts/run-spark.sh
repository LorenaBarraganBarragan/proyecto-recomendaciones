#!/usr/bin/env bash
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

echo "==> Enviando job ALS al cluster Spark"
docker exec \
  -e HOME=/tmp \
  -e CASSANDRA_HOST="${CASSANDRA_HOST:-cassandra}" \
  -e CASSANDRA_PORT="${CASSANDRA_PORT:-9042}" \
  -e CASSANDRA_KEYSPACE="${CASSANDRA_KEYSPACE:-ecommerce_rec}" \
  -e SPARK_ALS_RANK="${SPARK_ALS_RANK:-10}" \
  -e SPARK_ALS_ITERATIONS="${SPARK_ALS_ITERATIONS:-10}" \
  -e SPARK_ALS_REGPARAM="${SPARK_ALS_REGPARAM:-0.1}" \
  -e RECOMMENDATION_LIMIT="${RECOMMENDATION_LIMIT:-10}" \
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
    /opt/spark/jobs/als_job.py
