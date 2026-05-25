import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
export declare class AccessRequestController extends BaseController {
    createRequest(req: Request, res: Response, next: NextFunction): Promise<void>;
    getMyRequests(req: Request, res: Response, next: NextFunction): Promise<void>;
    getPendingRequests(req: Request, res: Response, next: NextFunction): Promise<void>;
    getRequestDetail(req: Request, res: Response, next: NextFunction): Promise<void>;
    reviewRequest(req: Request, res: Response, next: NextFunction): Promise<void>;
}
