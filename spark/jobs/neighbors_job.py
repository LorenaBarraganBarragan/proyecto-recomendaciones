"""Job Spark vecinal: recomendaciones por co-ocurrencia de sesiones.

A diferencia de ALS (factorización latente), este job construye un vecindario
real: dos usuarios son vecinos si interactuaron con los mismos productos. Es la
misma idea que el grafo Neo4j, pero calculada con Spark SQL sobre Cassandra.

Se envía con:
    scripts/run-neighbors.sh
"""

import os

from pyspark.sql import SparkSession, Window
from pyspark.sql.functions import (
    col,
    countDistinct,
    current_timestamp,
    desc,
    lit,
    max as spark_max,
    min as spark_min,
    row_number,
    sum as spark_sum,
    when,
)

KEYSPACE = os.getenv("CASSANDRA_KEYSPACE", "ecommerce_rec")
TOP_N = int(os.getenv("RECOMMENDATION_LIMIT", "10"))
MIN_SHARED = int(os.getenv("SPARK_NEIGHBORS_MIN_SHARED", "1"))


def build_spark():
    return (
        SparkSession.builder.appName(
            os.getenv("SPARK_APP_NAME", "ecommerce-spark-neighbors")
        )
        .config(
            "spark.cassandra.connection.host",
            os.getenv("CASSANDRA_HOST", "cassandra"),
        )
        .config("spark.cassandra.connection.port", os.getenv("CASSANDRA_PORT", "9042"))
        .getOrCreate()
    )


def read_table(spark, table):
    return (
        spark.read.format("org.apache.spark.sql.cassandra")
        .options(table=table, keyspace=KEYSPACE)
        .load()
    )


def write_table(output):
    (
        output.write.format("org.apache.spark.sql.cassandra")
        .options(
            table="recommendations_spark_neighbors",
            keyspace=KEYSPACE,
            **{"confirm.truncate": "true"},
        )
        .mode("overwrite")
        .save()
    )


def main():
    spark = build_spark()
    spark.sparkContext.setLogLevel("WARN")

    sessions = read_table(spark, "user_sessions")
    reviews = read_table(spark, "product_reviews")
    products = (
        read_table(spark, "products_by_catalog")
        .select("product_id", "title", "category", "price")
        .withColumnRenamed("product_id", "p_product_id")
    )

    # Las reseñas del dataset aportan el vecindario real; los eventos de sesión
    # incorporan los clics en vivo. Un mismo usuario/producto cuenta una sola vez.
    session_interactions = sessions.select(
        "user_id",
        "product_id",
        when(col("event_type") == lit("purchase"), lit(5.0))
        .when(col("event_type") == lit("click"), lit(2.5))
        .otherwise(lit(1.0))
        .alias("weight"),
    )
    review_interactions = reviews.select(
        "user_id",
        "product_id",
        when(col("rating") >= lit(4), lit(2.5))
        .when(col("rating") >= lit(3), lit(1.5))
        .otherwise(lit(1.0))
        .alias("weight"),
    )

    interactions = (
        session_interactions.unionByName(review_interactions)
        .filter(col("user_id").isNotNull() & col("product_id").isNotNull())
        # Los eventos de demostraciones anteriores pueden apuntar a productos
        # que ya no están en el catálogo: se descartan antes de buscar vecinos.
        .join(
            products.select(col("p_product_id").alias("catalog_product_id")),
            col("product_id") == col("catalog_product_id"),
            "inner",
        )
        .drop("catalog_product_id")
        .groupBy("user_id", "product_id")
        .agg(spark_max("weight").alias("weight"))
    )

    # Pares de usuarios que compartieron al menos un producto.
    left = interactions.alias("a")
    right = interactions.alias("b")
    pairs = (
        left.join(
            right,
            (col("a.product_id") == col("b.product_id"))
            & (col("a.user_id") < col("b.user_id")),
        )
        .groupBy(
            col("a.user_id").alias("user_id"),
            col("b.user_id").alias("neighbor_id"),
        )
        .agg(countDistinct(col("a.product_id")).alias("shared_products"))
        .filter(col("shared_products") >= lit(MIN_SHARED))
    )

    # Vecindario en ambos sentidos.
    neighbors = pairs.select("user_id", "neighbor_id", "shared_products").union(
        pairs.select(
            col("neighbor_id").alias("user_id"),
            col("user_id").alias("neighbor_id"),
            col("shared_products"),
        )
    )

    # Productos de los vecinos que el usuario todavía no ha visto.
    candidates = (
        neighbors.alias("nb").join(
            interactions.alias("n"), col("nb.neighbor_id") == col("n.user_id")
        )
        .select(
            col("nb.user_id").alias("user_id"),
            col("nb.neighbor_id").alias("neighbor_id"),
            col("nb.shared_products").alias("shared_products"),
            col("n.product_id").alias("product_id"),
            col("n.weight").alias("weight"),
        )
        .alias("cand")
        .join(
            interactions.alias("mine"),
            (col("cand.user_id") == col("mine.user_id"))
            & (col("cand.product_id") == col("mine.product_id")),
            "left_anti",
        )
        .select("cand.*")
    )

    scored = candidates.groupBy("user_id", "product_id").agg(
        spark_sum(col("weight") * col("shared_products")).alias("score"),
        countDistinct("neighbor_id").alias("neighbor_count"),
        spark_max("shared_products").alias("shared_products"),
        spark_min("neighbor_id").alias("example_neighbor"),
    )

    window = Window.partitionBy("user_id").orderBy(
        desc("score"), col("product_id")
    )
    ranked = (
        scored.withColumn("rank", row_number().over(window))
        .filter(col("rank") <= lit(TOP_N))
    )

    output = (
        ranked.join(products, ranked.product_id == products.p_product_id, "inner")
        .withColumn("generated_at", current_timestamp())
        .select(
            "user_id",
            "rank",
            "product_id",
            "title",
            "category",
            "price",
            "score",
            "neighbor_count",
            "shared_products",
            "example_neighbor",
            "generated_at",
        )
    )

    write_table(output)
    print(
        f"[neighbors_job] pares de vecinos={pairs.count()} · "
        f"recomendaciones={output.count()} escritas en recommendations_spark_neighbors"
    )
    spark.stop()


if __name__ == "__main__":
    main()
