import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { ensureTopic } from './kafka/client.js';
import { apiRouter, errorHandler } from './routes/api.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use('/api', apiRouter);
app.use(errorHandler);

app.listen(config.port, '0.0.0.0', () => {
  logger.info('server', `API escuchando en http://0.0.0.0:${config.port}/api`);
  ensureTopic().catch((error) => logger.warn('server', `No se pudo crear el tópico al arrancar: ${error.message}`));
});
