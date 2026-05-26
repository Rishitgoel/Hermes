import { Request, Response, NextFunction } from 'express';
export interface AuthenticatedUser {
    id: string;
    username: string;
    email: string;
    roles: string[];
}
declare module 'express-serve-static-core' {
    interface Request {
        user?: AuthenticatedUser;
        auth?: any;
    }
}
export declare const authenticateToken: (((req: Request, res: Response, next: NextFunction) => void) | ((err: any, req: Request, res: Response, next: NextFunction) => void))[];
export declare const requireRole: (requiredRoles: string[]) => (req: Request, res: Response, next: NextFunction) => void;
export declare const getAdminGroupSlugsFromRoles: (userRoles: string[]) => string[];
export declare const checkIsGroupAdmin: (userRoles: string[], groupSlug: string) => boolean;
