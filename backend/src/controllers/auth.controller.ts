import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';

export class AuthController extends BaseController {
  // GET /auth/me
  async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.user) {
        this.sendErrorResponse('User session not found', 401);
        return;
      }
      this.sendResponse(this.user, 'Session authenticated successfully');
    } catch (error) {
      this.handleError(error, 'Failed to authenticate session');
    }
  }
}

export default AuthController;
