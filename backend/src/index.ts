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

const app = express();

// Security and utility middleware
app.use(helmetMiddleware);
app.use(securityHeaders);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174')
  .split(',')
  .map(o => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
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
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
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
export { app };
