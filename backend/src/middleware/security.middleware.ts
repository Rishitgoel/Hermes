import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import logger from '../utils/logger';
import config from '../config/config';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
}

class SecurityService {
  createRateLimiter(rateLimitConfig: RateLimitConfig) {
    if (!config.rateLimiting.enabled) {
      return (req: Request, res: Response, next: NextFunction) => {
        next();
      };
    }

    return rateLimit({
      windowMs: rateLimitConfig.windowMs,
      max: rateLimitConfig.max,
      message: rateLimitConfig.message || 'Too many requests, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req): string => {
        const forwarded = req.headers['x-forwarded-for'];
        const ip = forwarded
          ? Array.isArray(forwarded)
            ? forwarded[0]
            : forwarded.split(',')[0]
          : req.ip;
        return ip || 'unknown';
      },
      handler: (req, res) => {
        logger.warn(
          {
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            url: req.url,
            max: rateLimitConfig.max,
            windowMs: rateLimitConfig.windowMs,
          },
          'Rate limit exceeded',
        );
        res.status(429).json({
          success: false,
          error: rateLimitConfig.message || 'Too many requests, please try again later.',
          metadata: {
            timestamp: new Date().toISOString(),
            retryAfter: Math.ceil(rateLimitConfig.windowMs / 1000),
          },
        });
      },
    });
  }

  getGeneralRateLimiter() {
    return this.createRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: config.isDev ? 1000 : 100,
    });
  }

  getHelmetConfig() {
    return helmet({
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
    return (req: Request, res: Response, next: NextFunction) => {
      res.removeHeader('X-Powered-By');
      res.removeHeader('Server');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader(
        'Permissions-Policy',
        'geolocation=(), microphone=(), camera=()'
      );
      next();
    };
  }
}

export const securityService = new SecurityService();

export const generalRateLimiter = securityService.getGeneralRateLimiter();
export const helmetMiddleware = securityService.getHelmetConfig();
export const securityHeaders = securityService.createSecurityHeaders();

export default securityService;
