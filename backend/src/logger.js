import { config } from './config.js';

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = levels[config.logLevel] ?? levels.info;

function emit(level, scope, message, meta) {
  if (levels[level] > threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${message}`;
  const args = meta === undefined ? [line] : [line, meta];
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(...args);
}

export const logger = {
  error: (scope, message, meta) => emit('error', scope, message, meta),
  warn: (scope, message, meta) => emit('warn', scope, message, meta),
  info: (scope, message, meta) => emit('info', scope, message, meta),
  debug: (scope, message, meta) => emit('debug', scope, message, meta),
};
