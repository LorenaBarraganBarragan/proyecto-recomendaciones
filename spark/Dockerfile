FROM apache/spark:3.5.0

# PySpark ML (ALS) necesita numpy en el driver y en los executors.
USER root
RUN python3 -m pip install --no-cache-dir "numpy==1.24.4"
USER spark
