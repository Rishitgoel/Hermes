import logger from './logger';

// Base error class with enhanced properties
export abstract class BaseError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly isOperational: boolean;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;
  public readonly userId?: string;
  public readonly requestId?: string;

  constructor(
    message: string,
    statusCode: number,
    errorCode: string,
    isOperational = true,
    context?: Record<string, unknown>,
    userId?: string,
    requestId?: string,
  ) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.timestamp = new Date();
    this.context = context;
    this.userId = userId;
    this.requestId = requestId;

    // Maintain proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      errorCode: this.errorCode,
      timestamp: this.timestamp.toISOString(),
      context: this.context,
      userId: this.userId,
      requestId: this.requestId,
      stack: process.env.NODE_ENV === 'production' ? undefined : this.stack,
    };
  }
}

// Validation errors (400)
export class ValidationError extends BaseError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    userId?: string,
    requestId?: string,
  ) {
    super(message, 400, 'VALIDATION_ERROR', true, context, userId, requestId);
  }
}

// Authentication errors (401)
export class AuthenticationError extends BaseError {
  constructor(
    message: string = 'Authentication required',
    context?: Record<string, unknown>,
    userId?: string,
    requestId?: string,
  ) {
    super(
      message,
      401,
      'AUTHENTICATION_ERROR',
      true,
      context,
      userId,
      requestId,
    );
  }
}

// Authorization errors (403)
export class AuthorizationError extends BaseError {
  constructor(
    message: string = 'Insufficient permissions',
    context?: Record<string, unknown>,
    userId?: string,
    requestId?: string,
  ) {
    super(
      message,
      403,
      'AUTHORIZATION_ERROR',
      true,
      context,
      userId,
      requestId,
    );
  }
}

// Not found errors (404)
export class NotFoundError extends BaseError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    userId?: string,
    requestId?: string,
  ) {
    super(message, 404, 'NOT_FOUND_ERROR', true, context, userId, requestId);
  }
}

// Conflict errors (409)
export class ConflictError extends BaseError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    userId?: string,
    requestId?: string,
  ) {
    super(message, 409, 'CONFLICT_ERROR', true, context, userId, requestId);
  }
}

// External service errors (502)
export class ExternalServiceError extends BaseError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    userId?: string,
    requestId?: string,
  ) {
    super(
      message,
      502,
      'EXTERNAL_SERVICE_ERROR',
      true,
      context,
      userId,
      requestId,
    );
  }
}

// Internal server errors (500)
export class InternalServerError extends BaseError {
  constructor(
    message: string = 'Internal server error',
    context?: Record<string, unknown>,
    userId?: string,
    requestId?: string,
  ) {
    super(
      message,
      500,
      'INTERNAL_SERVER_ERROR',
      false,
      context,
      userId,
      requestId,
    );
  }
}

// Error monitoring and reporting
export class ErrorMonitor {
  private static instance: ErrorMonitor;
  private errorCounts: Map<string, number> = new Map();
  private recentErrors: BaseError[] = [];
  private readonly maxRecentErrors = 100;

  static getInstance(): ErrorMonitor {
    if (!ErrorMonitor.instance) {
      ErrorMonitor.instance = new ErrorMonitor();
    }
    return ErrorMonitor.instance;
  }

  reportError(
    error: BaseError | Error,
    context?: Record<string, unknown>,
  ): void {
    let processedError: BaseError;

    if (error instanceof BaseError) {
      processedError = error;
    } else {
      processedError = new InternalServerError(error.message, {
        ...context,
        originalStack: error.stack,
      });
    }

    const errorKey = processedError.errorCode;
    this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) || 0) + 1);

    this.recentErrors.push(processedError);
    if (this.recentErrors.length > this.maxRecentErrors) {
      this.recentErrors = this.recentErrors.slice(-this.maxRecentErrors);
    }

    this.logError(processedError);

    if (this.isCriticalError(processedError)) {
      this.alertCriticalError(processedError);
    }
  }

  private logError(error: BaseError): void {
    const logLevel = error.statusCode >= 500 ? 'error' : 'warn';

    logger[logLevel](
      {
        error: error.toJSON(),
        stack: error.stack,
      },
      `${error.constructor.name}: ${error.message}`,
    );
  }

  private isCriticalError(error: BaseError): boolean {
    return error.statusCode >= 500 && !error.isOperational;
  }

  private alertCriticalError(error: BaseError): void {
    logger.fatal(
      {
        alert: 'CRITICAL_ERROR',
        error: error.toJSON(),
      },
      'Critical error detected - immediate attention required',
    );
  }
}

export const errorMonitor = ErrorMonitor.getInstance();
