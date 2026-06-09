import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import provisioningRegistry from '../services/provisioning.registry';

export class PlatformController extends BaseController {
  // GET /api/platforms
  // Platform keys that have a live provisioning adapter registered (e.g.
  // ["redash", "aws"]). The frontend derives each platform card's ACTIVE vs
  // COMING_SOON status from this instead of hardcoding it, so registering a new
  // adapter in the provisioning registry flips its card to ACTIVE with no frontend
  // change.
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      this.sendResponse({ live: provisioningRegistry.listPlatforms() }, 'Platforms retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve platforms');
    }
  }
}

export default PlatformController;
