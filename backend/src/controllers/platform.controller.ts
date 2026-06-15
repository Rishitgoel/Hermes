import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import provisioningRegistry from '../services/provisioning.registry';
import config from '../config/config';

export class PlatformController extends BaseController {
  // GET /api/platforms
  // Live provisioning adapters, straight from the registry. Returns both:
  //  - `live`: the platform keys (e.g. ["redash", "aws"]) — the frontend derives
  //    each card's ACTIVE vs COMING_SOON status from this, so registering an
  //    adapter flips its card with no frontend change.
  //  - `platforms`: per-platform { key, displayName, launchUrl } — adapter-owned,
  //    so the UI can label and link a grant to its platform without branching on
  //    the key. `launchUrl` is null when the adapter has none configured.
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const platforms = provisioningRegistry.listPlatforms()
        .filter((key) => key !== 'aws' || config.aws.isEnabled)
        .map((key) => {
          const adapter = provisioningRegistry.get(key);
          return {
            key,
            displayName: adapter.displayName,
            launchUrl: adapter.getLaunchUrl?.() ?? null,
          };
        });
      this.sendResponse(
        { live: platforms.map((p) => p.key), platforms },
        'Platforms retrieved',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve platforms');
    }
  }
}

export default PlatformController;
