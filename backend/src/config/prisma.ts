import { PrismaClient } from '../../generated/hermes';
import config from './config';
import logger from '../utils/logger';

if (!process.env.DATABASE_URL_HERMES && process.env.DATABASE_URL) {
  process.env.DATABASE_URL_HERMES = process.env.DATABASE_URL;
}

if (!process.env.DATABASE_URL_HERMES) {
  logger.warn('DATABASE_URL_HERMES is not set — hermes database will be unavailable');
}

const prisma = new PrismaClient({
  log: config.isDev ? ['query', 'info', 'warn', 'error'] : ['error', 'warn'],
  // Connection pool size is controlled via the DATABASE_URL query param:
  // ?connection_limit=10&pool_timeout=30
});

export default prisma;
