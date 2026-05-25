import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
export declare class GroupController extends BaseController {
    getGroups(req: Request, res: Response, next: NextFunction): Promise<void>;
    getGroupDetail(req: Request, res: Response, next: NextFunction): Promise<void>;
}
