import cassandra from 'cassandra-driver';
import { config } from '../config.js';

let client;

export function getCassandraClient() {
  if (!client) {
    client = new cassandra.Client({
      contactPoints: config.cassandra.contactPoints,
      localDataCenter: config.cassandra.localDataCenter,
      keyspace: config.cassandra.keyspace,
      pooling: { coreConnectionsPerHost: { [cassandra.types.distance.local]: 2 } },
      queryOptions: { prepare: true, fetchSize: 5000 },
    });
  }
  return client;
}

export function execute(cql, params = [], options = {}) {
  return getCassandraClient().execute(cql, params, { prepare: true, ...options });
}

export async function batch(statements) {
  if (!statements.length) return;
  await getCassandraClient().batch(statements, { prepare: true, consistency: cassandra.types.consistencies.one });
}

export async function closeCassandra() {
  if (client) {
    await client.shutdown();
    client = undefined;
  }
}
