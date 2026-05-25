import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
export declare class AdminController extends BaseController {
    triggerSync(req: Request, res: Response, next: NextFunction): Promise<void>;
}
