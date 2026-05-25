"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.securityHeaders = exports.helmetMiddleware = exports.generalRateLimiter = exports.securityService = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const helmet_1 = __importDefault(require("helmet"));
const logger_1 = __importDefault(require("../utils/logger"));
class SecurityService {
    config;
    constructor() {
        this.config = {
            enableRateLimit: process.env.ENABLE_RATE_LIMIT === 'true',
            enableHelmet: process.env.SECURITY_HELMET !== 'false',
            allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
                .split(',')
                .filter(Boolean),
        };
    }
    createRateLimiter(config) {
        if (!this.config.enableRateLimit) {
            return (req, res, next) => {
                next();
            };
        }
        return (0, express_rate_limit_1.default)({
            windowMs: config.windowMs,
            max: config.max,
            message: config.message || 'Too many requests, please try again later.',
            standardHeaders: true,
            legacyHeaders: false,
            keyGenerator: (req) => {
                const forwarded = req.headers['x-forwarded-for'];
                const ip = forwarded
                    ? Array.isArray(forwarded)
                        ? forwarded[0]
                        : forwarded.split(',')[0]
                    : req.ip;
                return ip || 'unknown';
            },
            handler: (req, res) => {
                logger_1.default.warn({
                    ip: req.ip,
                    userAgent: req.headers['user-agent'],
                    url: req.url,
                    max: config.max,
                    windowMs: config.windowMs,
                }, 'Rate limit exceeded');
                res.status(429).json({
                    success: false,
                    error: config.message || 'Too many requests, please try again later.',
                    metadata: {
                        timestamp: new Date().toISOString(),
                        retryAfter: Math.ceil(config.windowMs / 1000),
                    },
                });
            },
        });
    }
    getGeneralRateLimiter() {
        const isDevelopment = process.env.NODE_ENV === 'development';
        return this.createRateLimiter({
            windowMs: 15 * 60 * 1000,
            max: isDevelopment ? 1000 : 100,
        });
    }
    getHelmetConfig() {
        return (0, helmet_1.default)({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", 'data:', 'https:'],
                    connectSrc: ["'self'"],
                    fontSrc: ["'self'"],
                    objectSrc: ["'none'"],
                    mediaSrc: ["'self'"],
                    frameSrc: ["'none'"],
                },
            },
            crossOriginEmbedderPolicy: false,
            hsts: {
                maxAge: 31536000,
                includeSubDomains: true,
                preload: true,
            },
        });
    }
    createSecurityHeaders() {
        return (req, res, next) => {
            res.removeHeader('X-Powered-By');
            res.removeHeader('Server');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
            res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
            next();
        };
    }
}
exports.securityService = new SecurityService();
exports.generalRateLimiter = exports.securityService.getGeneralRateLimiter();
exports.helmetMiddleware = exports.securityService.getHelmetConfig();
exports.securityHeaders = exports.securityService.createSecurityHeaders();
exports.default = exports.securityService;
