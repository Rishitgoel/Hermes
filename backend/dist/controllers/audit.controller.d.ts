import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
export declare class AuditController extends BaseController {
    getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void>;
}
