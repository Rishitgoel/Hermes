import { PlatformAdapter } from './provisioner.interface';
import { redashProvisioner } from './redash.provisioner';
import logger from '../utils/logger';

class ProvisioningRegistry {
  private registry = new Map<string, PlatformAdapter>();

  constructor() {
    // Register standard platform provisioners
    this.register('redash', redashProvisioner);
  }

  register(platform: string, adapter: PlatformAdapter) {
    const key = platform.toLowerCase();
    this.registry.set(key, adapter);
    logger.info(`🔌 Provisioning Registry: Registered provisioner for platform "${key}"`);
  }

  get(platform: string): PlatformAdapter {
    const key = platform.toLowerCase();
    const adapter = this.registry.get(key);
    if (!adapter) {
      throw new Error(`No provisioner registered for platform "${platform}"`);
    }
    return adapter;
  }

  has(platform: string): boolean {
    return this.registry.has(platform.toLowerCase());
  }

  listPlatforms(): string[] {
    return Array.from(this.registry.keys());
  }

  async healthCheckAll(): Promise<Record<string, { healthy: boolean; message?: string }>> {
    const results: Record<string, { healthy: boolean; message?: string }> = {};
    for (const [key, adapter] of this.registry) {
      try {
        results[key] = await adapter.healthCheck();
      } catch (err: any) {
        results[key] = { healthy: false, message: err.message };
      }
    }
    return results;
  }
}

export const provisioningRegistry = new ProvisioningRegistry();
export default provisioningRegistry;
