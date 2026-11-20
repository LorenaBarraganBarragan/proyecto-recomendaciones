import { writeCypher, closeNeo4j } from '../db/neo4j.js';
import { logger } from '../logger.js';

async function main() {
  await writeCypher('CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE');
  await writeCypher('CREATE CONSTRAINT product_id IF NOT EXISTS FOR (p:Product) REQUIRE p.id IS UNIQUE');
  logger.info('neo4j', 'Constraints de User.id y Product.id creados/verificados');
}

main()
  .catch((error) => {
    logger.error('neo4j', error.message);
    process.exitCode = 1;
  })
  .finally(closeNeo4j);
