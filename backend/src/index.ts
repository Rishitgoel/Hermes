import express, { Request, Response } from 'express';
import cors from 'cors';
import { helmetMiddleware, securityHeaders, generalRateLimiter } from './middleware/security.middleware';
import { requestIdMiddleware, performanceMiddleware, errorHandler, notFoundHandler } from './middleware/error.middleware';
import { authenticateToken, requireRole } from './middleware/auth.middleware';

import authRouter from './routes/auth.route';
import groupRouter from './routes/group.route';
import accessRequestRouter from './routes/access-request.route';
import userAccessRouter from './routes/user-access.route';
import notificationRouter from './routes/notification.route';
import auditRouter from './routes/audit.route';
import adminRouter from './routes/admin.route';
import userCreationRouter from './routes/user-creation.route';

import config from './config/config';
import prisma from './config/prisma';
import provisioningRegistry from './services/provisioning.registry';
import syncService from './services/sync.service';

const app = express();

// Trust the configured number of proxy hops (ALB / API Gateway) so req.ip is the real
// client and X-Forwarded-For can't be spoofed to bypass rate limiting.
app.set('trust proxy', config.security.trustProxy);

// Liveness probe — public, trivial, and mounted before all other middleware
// (including rate limiting) so load-balancer / container health checks are never
// throttled or blocked. No DB or outbound calls → can't amplify load or fingerprint
// dependencies. Deep diagnostics live behind auth at GET /health/deep.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

app.use(express.json({ limit: '50kb' }));
app.use(requestIdMiddleware);
app.use(performanceMiddleware);
app.use(generalRateLimiter);

// Deep diagnostics — DB + live platform health. Behind super-admin auth so anonymous
// callers can't trigger outbound platform calls (amplification) or read dependency
// topology. The public liveness probe above stays minimal.
app.get('/health/deep', authenticateToken, requireRole(['hermes_super_admin']), async (req: Request, res: Response) => {
  const checks: Record<string, any> = { timestamp: new Date().toISOString() };

  // Database check. Don't surface raw error text in prod — Prisma error messages
  // can leak DB hostnames, usernames, and schema hints.
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'healthy';
  } catch (err: any) {
    checks.database = 'unhealthy';
    if (config.isDev) checks.databaseError = err.message;
  }

  // Platform checks (via registry)
  try {
    checks.platforms = await provisioningRegistry.healthCheckAll();
  } catch (err: any) {
    checks.platforms = 'error';
    if (config.isDev) checks.platformsError = err.message;
  }

  // Last successful platform sync of any platform (null if never run)
  checks.lastSyncAt = syncService.getLastSyncedAt()?.toISOString() ?? null;

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
app.use('/api/user-creation-requests', userCreationRouter);

// Fallbacks
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
