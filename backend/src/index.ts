import express from 'express';
import cors from 'cors';
import { helmetMiddleware, securityHeaders, generalRateLimiter } from './middleware/security.middleware';
import { requestIdMiddleware, performanceMiddleware, errorHandler, notFoundHandler } from './middleware/error.middleware';

import authRouter from './routes/auth.route';
import groupRouter from './routes/group.route';
import accessRequestRouter from './routes/access-request.route';
import userAccessRouter from './routes/user-access.route';
import notificationRouter from './routes/notification.route';
import auditRouter from './routes/audit.route';
import adminRouter from './routes/admin.route';

import config from './config/config';
import prisma from './config/prisma';
import provisioningRegistry from './services/provisioning.registry';
import syncService from './services/sync.service';

const app = express();

// Security and utility middleware
app.use(helmetMiddleware);
app.use(securityHeaders);

const allowedOrigins = config.frontend.allowedOrigins;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        // Allow server-to-server / health-check / Postman only in non-prod
        if (config.isDev) {
          callback(null, true);
        } else {
          callback(new Error('Origin header required in production'));
        }
      } else if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(requestIdMiddleware);
app.use(performanceMiddleware);
app.use(generalRateLimiter);

// Health check endpoint (unauthenticated)
app.get('/health', async (req, res) => {
  const checks: Record<string, any> = { timestamp: new Date().toISOString() };

  // Database check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'healthy';
  } catch (err: any) {
    checks.database = 'unhealthy';
    checks.databaseError = err.message;
  }

  // Platform checks (via registry)
  try {
    checks.platforms = await provisioningRegistry.healthCheckAll();
  } catch (err: any) {
    checks.platforms = 'error';
    checks.platformsError = err.message;
  }

  // Last successful Redash sync (null if never run)
  checks.lastRedashSyncAt = syncService.getLastSyncedAt()?.toISOString() ?? null;

  const allHealthy = checks.database === 'healthy';
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'degraded',
    ...checks,
  });
});

// App Routes
app.use('/auth', authRouter);
app.use('/api/groups', groupRouter);
app.use('/api/access-requests', accessRequestRouter);
app.use('/api/user-access', userAccessRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/audit', auditRouter);
app.use('/api/admin', adminRouter);

// Fallbacks
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
