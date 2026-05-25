import { Request, Response, NextFunction } from 'express';
import { BaseError, NotFoundError, errorMonitor } from '../utils/errors';
import { ApiResponse } from '../controllers/base.controller';
import { AuthenticatedUser } from './auth.middleware';
import defaultLogger from '../utils/logger';

interface ExtendedRequest extends Request {
  requestId?: string;
  user?: AuthenticatedUser;
}

export const errorHandler = (
  err: BaseError | Error | null | undefined,
  req: ExtendedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const logger = defaultLogger;
  const requestId = req.requestId || (req.headers['x-request-id'] as string);
  const userId = req.user?.id || req.user?.username;

  if (!err) {
    logger.error(
      {
        url: req.url,
        method: req.method,
        requestId,
        userId,
        error: 'Error handler called with null/undefined error',
      },
      'Null/undefined error in error handler',
    );

    const response: ApiResponse = {
      success: false,
      error: 'Unknown error occurred',
      metadata: {
        timestamp: new Date().toISOString(),
        requestId,
      },
    };

    res.status(500).json(response);
    return;
  }

  errorMonitor.reportError(err, {
    url: req.url,
    method: req.method,
    userAgent: req.headers['user-agent'],
    ip: req.ip,
    requestId,
    userId,
  });

  if (err instanceof BaseError) {
    const response: ApiResponse = {
      success: false,
      error:
        process.env.NODE_ENV === 'production' && err.statusCode >= 500
          ? 'Internal server error occurred'
          : err.message,
      metadata: {
        timestamp: new Date().toISOString(),
        requestId,
        errorCode: err.errorCode,
      },
    };

    if (process.env.NODE_ENV !== 'production') {
      response.metadata = {
        ...response.metadata,
        context: err.context,
        stack: err.stack,
      };
    }

    res.status(err.statusCode).json(response);
    return;
  }

  const statusCode = (err as BaseError & { statusCode?: number }).statusCode || 500;

  logger.error(
    {
      error: {
        message: err.message || 'Unknown error',
        name: err.name || 'Error',
        stack: err.stack || 'No stack trace available',
        statusCode,
      },
      request: {
        url: req.url,
        method: req.method,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        requestId,
        userId,
      },
    },
    'Unhandled error occurred',
  );

  const response: ApiResponse = {
    success: false,
    error:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error occurred'
        : err?.message || 'Unknown error occurred',
    metadata: {
      timestamp: new Date().toISOString(),
      requestId,
    },
  };

  if (process.env.NODE_ENV !== 'production') {
    response.metadata = {
      ...response.metadata,
      stack: err?.stack || 'No stack trace available',
    };
  }

  res.status(statusCode).json(response);
};

export const notFoundHandler = (
  req: ExtendedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const logger = defaultLogger;
  const requestId = req.requestId || (req.headers['x-request-id'] as string);
  const userId = req.user?.id || req.user?.username;

  const notFoundError = new NotFoundError(
    `Route ${req.method} ${req.url} not found`,
    {
      method: req.method,
      url: req.url,
      userAgent: req.headers['user-agent'],
    },
    userId,
    requestId,
  );

  errorMonitor.reportError(notFoundError);

  logger.warn(
    {
      url: req.url,
      method: req.method,
      requestId,
      userId,
    },
    'Route not found',
  );

  const response: ApiResponse = {
    success: false,
    error: notFoundError.message,
    metadata: {
      timestamp: new Date().toISOString(),
      requestId,
      errorCode: notFoundError.errorCode,
    },
  };

  res.status(404).json(response);
};

export const requestIdMiddleware = (
  req: ExtendedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const requestId =
    (req.headers['x-request-id'] as string) ||
    `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  next();
};

export const performanceMiddleware = (
  req: ExtendedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logger = defaultLogger;

    if (duration > 5000) {
      logger.warn(
        {
          performance: {
            method: req.method,
            url: req.url,
            duration,
            statusCode: res.statusCode,
            requestId: req.requestId,
          },
        },
        'Slow request detected',
      );
    }

    logger.info(
      {
        request: {
          method: req.method,
          url: req.url,
          duration,
          statusCode: res.statusCode,
          requestId: req.requestId,
          userId: req.user?.id,
        },
      },
      'Request completed',
    );
  });

  next();
};
