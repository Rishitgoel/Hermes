import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
export declare class AuthController extends BaseController {
    getMe(req: Request, res: Response, next: NextFunction): Promise<void>;
}
export default AuthController;
