import { Request, Response, NextFunction } from 'express';
import { BaseError } from '../utils/errors';
import { AuthenticatedUser } from './auth.middleware';
interface ExtendedRequest extends Request {
    requestId?: string;
    user?: AuthenticatedUser;
}
export declare const errorHandler: (err: BaseError | Error | null | undefined, req: ExtendedRequest, res: Response, next: NextFunction) => void;
export declare const notFoundHandler: (req: ExtendedRequest, res: Response, next: NextFunction) => void;
export declare const requestIdMiddleware: (req: ExtendedRequest, res: Response, next: NextFunction) => void;
export declare const performanceMiddleware: (req: ExtendedRequest, res: Response, next: NextFunction) => void;
export {};
