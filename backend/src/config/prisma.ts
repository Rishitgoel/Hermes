import { PrismaClient } from '@prisma/client';
import config from './config';

const prisma = new PrismaClient({
  log: config.isDev ? ['query', 'info', 'warn', 'error'] : ['error', 'warn'],
  // Connection pool size is controlled via the DATABASE_URL query param:
  // ?connection_limit=10&pool_timeout=30
});

export default prisma;
