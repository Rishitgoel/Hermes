import { Request, Response, NextFunction } from 'express';
interface RateLimitConfig {
    windowMs: number;
    max: number;
    message?: string;
}
declare class SecurityService {
    createRateLimiter(rateLimitConfig: RateLimitConfig): (req: Request, res: Response, next: NextFunction) => void;
    getGeneralRateLimiter(): (req: Request, res: Response, next: NextFunction) => void;
    getHelmetConfig(): (req: import("http").IncomingMessage, res: import("http").ServerResponse, next: (err?: unknown) => void) => void;
    createSecurityHeaders(): (req: Request, res: Response, next: NextFunction) => void;
}
export declare const securityService: SecurityService;
export declare const generalRateLimiter: (req: Request, res: Response, next: NextFunction) => void;
export declare const helmetMiddleware: (req: import("http").IncomingMessage, res: import("http").ServerResponse, next: (err?: unknown) => void) => void;
export declare const securityHeaders: (req: Request, res: Response, next: NextFunction) => void;
export default securityService;
