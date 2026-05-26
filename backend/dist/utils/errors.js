"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMonitor = exports.ErrorMonitor = exports.InternalServerError = exports.ExternalServiceError = exports.ConflictError = exports.NotFoundError = exports.AuthorizationError = exports.AuthenticationError = exports.ValidationError = exports.BaseError = void 0;
const logger_1 = __importDefault(require("./logger"));
// Base error class with enhanced properties
class BaseError extends Error {
    statusCode;
    errorCode;
    isOperational;
    timestamp;
    context;
    userId;
    requestId;
    constructor(message, statusCode, errorCode, isOperational = true, context, userId, requestId) {
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
exports.BaseError = BaseError;
// Validation errors (400)
class ValidationError extends BaseError {
    constructor(message, context, userId, requestId) {
        super(message, 400, 'VALIDATION_ERROR', true, context, userId, requestId);
    }
}
exports.ValidationError = ValidationError;
// Authentication errors (401)
class AuthenticationError extends BaseError {
    constructor(message = 'Authentication required', context, userId, requestId) {
        super(message, 401, 'AUTHENTICATION_ERROR', true, context, userId, requestId);
    }
}
exports.AuthenticationError = AuthenticationError;
// Authorization errors (403)
class AuthorizationError extends BaseError {
    constructor(message = 'Insufficient permissions', context, userId, requestId) {
        super(message, 403, 'AUTHORIZATION_ERROR', true, context, userId, requestId);
    }
}
exports.AuthorizationError = AuthorizationError;
// Not found errors (404)
class NotFoundError extends BaseError {
    constructor(message, context, userId, requestId) {
        super(message, 404, 'NOT_FOUND_ERROR', true, context, userId, requestId);
    }
}
exports.NotFoundError = NotFoundError;
// Conflict errors (409)
class ConflictError extends BaseError {
    constructor(message, context, userId, requestId) {
        super(message, 409, 'CONFLICT_ERROR', true, context, userId, requestId);
    }
}
exports.ConflictError = ConflictError;
// External service errors (502)
class ExternalServiceError extends BaseError {
    constructor(message, context, userId, requestId) {
        super(message, 502, 'EXTERNAL_SERVICE_ERROR', true, context, userId, requestId);
    }
}
exports.ExternalServiceError = ExternalServiceError;
// Internal server errors (500)
class InternalServerError extends BaseError {
    constructor(message = 'Internal server error', context, userId, requestId) {
        super(message, 500, 'INTERNAL_SERVER_ERROR', false, context, userId, requestId);
    }
}
exports.InternalServerError = InternalServerError;
// Error monitoring and reporting
class ErrorMonitor {
    static instance;
    errorCounts = new Map();
    recentErrors = [];
    maxRecentErrors = 100;
    static getInstance() {
        if (!ErrorMonitor.instance) {
            ErrorMonitor.instance = new ErrorMonitor();
        }
        return ErrorMonitor.instance;
    }
    reportError(error, context) {
        let processedError;
        if (error instanceof BaseError) {
            processedError = error;
        }
        else {
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
    logError(error) {
        const logLevel = error.statusCode >= 500 ? 'error' : 'warn';
        logger_1.default[logLevel]({
            error: error.toJSON(),
            stack: error.stack,
        }, `${error.constructor.name}: ${error.message}`);
    }
    isCriticalError(error) {
        return error.statusCode >= 500 && !error.isOperational;
    }
    alertCriticalError(error) {
        logger_1.default.fatal({
            alert: 'CRITICAL_ERROR',
            error: error.toJSON(),
        }, 'Critical error detected - immediate attention required');
    }
}
exports.ErrorMonitor = ErrorMonitor;
exports.errorMonitor = ErrorMonitor.getInstance();
