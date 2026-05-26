import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
export declare class UserAccessController extends BaseController {
    getMyAccess(req: Request, res: Response, next: NextFunction): Promise<void>;
    getGroupAccessList(req: Request, res: Response, next: NextFunction): Promise<void>;
    revokeAccess(req: Request, res: Response, next: NextFunction): Promise<void>;
    getPlatformStatus(req: Request, res: Response, next: NextFunction): Promise<void>;
    invitePlatformUser(req: Request, res: Response, next: NextFunction): Promise<void>;
}
