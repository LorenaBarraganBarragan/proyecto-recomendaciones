"""Job Spark: ALS sobre reseñas + sesiones → recommendations_spark (Cassandra).

Se ejecuta dentro del cluster con:
    scripts/run-spark.sh
"""

import os

from pyspark.ml.feature import StringIndexer
from pyspark.ml.recommendation import ALS
from pyspark.sql import SparkSession, Window
from pyspark.sql.functions import (
    avg,
    col,
    count,
    current_timestamp,
    explode,
    lit,
    max as spark_max,
    row_number,
    when,
)

KEYSPACE = os.getenv("CASSANDRA_KEYSPACE", "ecommerce_rec")
CASSANDRA_HOST = os.getenv("CASSANDRA_HOST", "cassandra")
CASSANDRA_PORT = os.getenv("CASSANDRA_PORT", "9042")
RANK = int(os.getenv("SPARK_ALS_RANK", "10"))
ITERATIONS = int(os.getenv("SPARK_ALS_ITERATIONS", "10"))
REG_PARAM = float(os.getenv("SPARK_ALS_REGPARAM", "0.1"))
TOP_N = int(os.getenv("RECOMMENDATION_LIMIT", "10"))

EVENT_WEIGHTS = {"view": 1.0, "click": 2.5, "purchase": 5.0}


def build_spark():
    return (
        SparkSession.builder.appName(os.getenv("SPARK_APP_NAME", "ecommerce-als-recommender"))
        .config("spark.cassandra.connection.host", CASSANDRA_HOST)
        .config("spark.cassandra.connection.port", CASSANDRA_PORT)
        .config("spark.sql.shuffle.partitions", "8")
        .getOrCreate()
    )


def read_table(spark, table):
    return (
        spark.read.format("org.apache.spark.sql.cassandra")
        .options(table=table, keyspace=KEYSPACE)
        .load()
    )


def build_interactions(spark):
    reviews = read_table(spark, "product_reviews").select(
        col("user_id"),
        col("product_id"),
        col("rating").cast("double").alias("rating"),
    )

    sessions_raw = read_table(spark, "user_sessions")
    weight_expr = lit(1.0)
    for event_type, weight in EVENT_WEIGHTS.items():
        weight_expr = when(col("event_type") == event_type, lit(weight)).otherwise(weight_expr)

    sessions = (
        sessions_raw.withColumn("event_weight", weight_expr)
        .groupBy("user_id", "product_id")
        .agg(spark_max("event_weight").alias("rating"))
    )

    interactions = (
        reviews.unionByName(sessions)
        .groupBy("user_id", "product_id")
        .agg(avg("rating").alias("rating"))
        .filter(col("user_id").isNotNull() & col("product_id").isNotNull())
        .filter((col("rating") >= 0.5) & (col("rating") <= 5.0))
    )
    return interactions.cache()


def finalize(spark, recommendations, products):
    window = Window.partitionBy("user_id").orderBy(col("score").desc(), col("product_id").asc())
    return (
        recommendations.join(products, on="product_id", how="left")
        .withColumn("rank", row_number().over(window).cast("int"))
        .filter(col("rank") <= TOP_N)
        .withColumn("generated_at", current_timestamp())
        .select("user_id", "rank", "product_id", "title", "category", "price", "score", "generated_at")
    )


def labels_dataframe(spark, indexer, index_col, id_col):
    """Tabla índice ↔ id original para revertir el mapeo de StringIndexer."""
    rows = [(float(index), label) for index, label in enumerate(indexer.labels)]
    return spark.createDataFrame(rows, f"{index_col} double, {id_col} string")


def write_recommendations(output):
    (output.write.format("org.apache.spark.sql.cassandra")
     .options(table="recommendations_spark", keyspace=KEYSPACE, **{"confirm.truncate": "true"})
     .mode("overwrite").save())


def popularity_fallback(interactions, products, user_ids):
    """Fallback cuando no hay suficientes usuarios para entrenar ALS."""
    popular = (
        interactions.groupBy("product_id")
        .agg(avg("rating").alias("score"), count("*").alias("interactions"))
        .orderBy(col("score").desc(), col("interactions").desc(), col("product_id").asc())
        .limit(TOP_N)
    )
    users = user_ids.select("user_id")
    recommendations = users.crossJoin(popular)
    return finalize(users.sparkSession, recommendations, products)


def main():
    spark = build_spark()
    spark.sparkContext.setLogLevel("WARN")

    interactions = build_interactions(spark)
    products = read_table(spark, "products").select("product_id", "title", "category", "price")
    user_ids = interactions.select("user_id").distinct()
    user_count = user_ids.count()
    product_count = interactions.select("product_id").distinct().count()
    print(f"[als_job] interacciones={interactions.count()} usuarios={user_count} productos={product_count}")

    if user_count >= 2 and product_count >= 2:
        try:
            # ALS exige índices numéricos: mapeamos ids de texto y luego revertimos.
            user_indexer = StringIndexer(
                inputCol="user_id", outputCol="user_idx", handleInvalid="keep"
            ).fit(interactions)
            product_indexer = StringIndexer(
                inputCol="product_id", outputCol="product_idx", handleInvalid="keep"
            ).fit(interactions)
            indexed = product_indexer.transform(user_indexer.transform(interactions))

            als = ALS(
                rank=RANK,
                maxIter=ITERATIONS,
                regParam=REG_PARAM,
                userCol="user_idx",
                itemCol="product_idx",
                ratingCol="rating",
                coldStartStrategy="drop",
                nonnegative=True,
                seed=42,
            )
            model = als.fit(indexed)
            raw = (
                model.recommendForAllUsers(TOP_N)
                .select("user_idx", explode("recommendations").alias("rec"))
                .select(
                    col("user_idx").cast("double").alias("user_idx"),
                    col("rec.product_idx").cast("double").alias("product_idx"),
                    col("rec.rating").alias("score"),
                )
            )
            user_labels = labels_dataframe(spark, user_indexer, "user_idx", "user_id")
            product_labels = labels_dataframe(spark, product_indexer, "product_idx", "product_id")
            candidates = (
                raw.join(user_labels, on="user_idx")
                .join(product_labels, on="product_idx")
                .select("user_id", "product_id", "score")
            )
            seen = interactions.select("user_id", "product_id")
            candidates = candidates.join(seen, on=["user_id", "product_id"], how="left_anti")
            output = finalize(spark, candidates, products)
            write_recommendations(output)
            print("[als_job] Recomendaciones ALS guardadas en recommendations_spark")
            return
        except Exception as error:  # noqa: BLE001 - cualquier fallo de ALS usa el fallback
            print(f"[als_job] ALS falló ({error}); usando fallback de popularidad")

    output = popularity_fallback(interactions, products, user_ids)
    write_recommendations(output)
    print("[als_job] Recomendaciones por co-ocurrencia/popularidad guardadas")


if __name__ == "__main__":
    main()
