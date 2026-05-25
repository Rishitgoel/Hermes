"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.performanceMiddleware = exports.requestIdMiddleware = exports.notFoundHandler = exports.errorHandler = void 0;
const errors_1 = require("../utils/errors");
const logger_1 = __importDefault(require("../utils/logger"));
const errorHandler = (err, req, res, next) => {
    const logger = logger_1.default;
    const requestId = req.requestId || req.headers['x-request-id'];
    const userId = req.user?.id || req.user?.username;
    if (!err) {
        logger.error({
            url: req.url,
            method: req.method,
            requestId,
            userId,
            error: 'Error handler called with null/undefined error',
        }, 'Null/undefined error in error handler');
        const response = {
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
    errors_1.errorMonitor.reportError(err, {
        url: req.url,
        method: req.method,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        requestId,
        userId,
    });
    if (err instanceof errors_1.BaseError) {
        const response = {
            success: false,
            error: process.env.NODE_ENV === 'production' && err.statusCode >= 500
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
    const statusCode = err.statusCode || 500;
    logger.error({
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
    }, 'Unhandled error occurred');
    const response = {
        success: false,
        error: process.env.NODE_ENV === 'production'
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
exports.errorHandler = errorHandler;
const notFoundHandler = (req, res, next) => {
    const logger = logger_1.default;
    const requestId = req.requestId || req.headers['x-request-id'];
    const userId = req.user?.id || req.user?.username;
    const notFoundError = new errors_1.NotFoundError(`Route ${req.method} ${req.url} not found`, {
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent'],
    }, userId, requestId);
    errors_1.errorMonitor.reportError(notFoundError);
    logger.warn({
        url: req.url,
        method: req.method,
        requestId,
        userId,
    }, 'Route not found');
    const response = {
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
exports.notFoundHandler = notFoundHandler;
const requestIdMiddleware = (req, res, next) => {
    const requestId = req.headers['x-request-id'] ||
        `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
};
exports.requestIdMiddleware = requestIdMiddleware;
const performanceMiddleware = (req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logger = logger_1.default;
        if (duration > 5000) {
            logger.warn({
                performance: {
                    method: req.method,
                    url: req.url,
                    duration,
                    statusCode: res.statusCode,
                    requestId: req.requestId,
                },
            }, 'Slow request detected');
        }
        logger.info({
            request: {
                method: req.method,
                url: req.url,
                duration,
                statusCode: res.statusCode,
                requestId: req.requestId,
                userId: req.user?.id,
            },
        }, 'Request completed');
    });
    next();
};
exports.performanceMiddleware = performanceMiddleware;
