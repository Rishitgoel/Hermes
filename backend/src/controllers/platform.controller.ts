import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import provisioningRegistry from '../services/provisioning.registry';

export class PlatformController extends BaseController {
  // GET /api/platforms
  // Live provisioning adapters, straight from the registry. Returns both:
  //  - `live`: the platform keys (e.g. ["redash", "aws"]) — the frontend derives
  //    each card's ACTIVE vs COMING_SOON status from this, so registering an
  //    adapter flips its card with no frontend change.
  //  - `platforms`: per-platform { key, displayName, launchUrl, family, label } —
  //    adapter-owned, so the UI can label and link a grant to its platform
  //    without branching on the key. `launchUrl` is null when the adapter has
  //    none configured. `family` groups multiple instances of one platform
  //    (e.g. "redash" and "redash-qa" both have family "redash") so the
  //    frontend can collapse them into one card with an instance chooser;
  //    adapters that don't set it default to grouping by their own key (i.e.
  //    they render as a single, ungrouped card). `label` distinguishes an
  //    instance within its family (e.g. "Prod"/"QA"); null when not set.
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const platforms = provisioningRegistry
        .listPlatforms()
        .filter(key => {
          const adapter = provisioningRegistry.get(key);
          return !(adapter.isEnabled && !adapter.isEnabled());
        })
        .map(key => {
          const adapter = provisioningRegistry.get(key);
          return {
            key,
            displayName: adapter.displayName,
            launchUrl: adapter.getLaunchUrl?.() ?? null,
            family: adapter.family ?? key,
            label: adapter.label ?? null,
          };
        });
      this.sendResponse(
        { live: platforms.map(p => p.key), platforms },
        'Platforms retrieved',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve platforms');
    }
  }
}

export default PlatformController;
