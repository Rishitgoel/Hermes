import { PlatformAdapter } from './provisioner.interface';
import { createRedashProvisioner } from './redash.provisioner';
import { getRedashService } from './redash.service';
import { awsProvisioner } from './aws.provisioner';
import { zookeeperProvisioner } from './zookeeper.provisioner';
import { secretsProvisioner } from './secrets.provisioner';
import config from '../config/config';
import logger from '../utils/logger';

/**
 * Single dispatch point for platform routing.
 *
 * Maps a platform key (matching `Group.platform`, e.g. "redash") to the
 * {@link PlatformAdapter} that fulfils provisioning for it. The access-workflow
 * and sync services resolve adapters exclusively through this registry, so
 * adding a platform is a one-line `register(...)` call in the constructor — no
 * caller needs to change. Lookups are case-insensitive.
 */
export class ProvisioningRegistry {
  private registry = new Map<string, PlatformAdapter>();

  constructor() {
    // Register every configured Redash instance (prod always; additional
    // instances like QA are opt-in — an instance with no baseUrl configured is
    // skipped so an unconfigured entry never registers a dead adapter). Each
    // instance gets its own RedashService (own HTTP client / cache) and its own
    // RedashProvisioner (own platform key), so prod and QA never share state.
    for (const instance of config.redashInstances) {
      if (!instance.baseUrl) {
        logger.info(`🔌 Provisioning Registry: Skipping Redash instance "${instance.key}" (no base URL configured)`);
        continue;
      }
      const service = getRedashService(instance);
      this.register(instance.key, createRedashProvisioner({ ...instance, service }));
    }
    this.register('aws', awsProvisioner);
    this.register('zookeeper', zookeeperProvisioner);
    this.register('secrets', secretsProvisioner);
  }

  /** Add (or replace) the adapter for a platform. Key is lower-cased. */
  register(platform: string, adapter: PlatformAdapter) {
    const key = platform.toLowerCase();
    this.registry.set(key, adapter);
    logger.info(`🔌 Provisioning Registry: Registered provisioner for platform "${key}"`);
  }

  /**
   * Remove a platform's adapter. Primarily for test cleanup: a test that
   * registers a throwaway fake adapter on the shared singleton (register()
   * mutates the real exported registry — there's no per-test instance) must undo
   * it in afterEach, since vi.restoreAllMocks() does not touch a plain Map.set.
   * No-op if the platform was never registered.
   */
  unregister(platform: string): void {
    const key = platform.toLowerCase();
    this.registry.delete(key);
    logger.info(`🔌 Provisioning Registry: Unregistered provisioner for platform "${key}"`);
  }

  get(platform: string): PlatformAdapter {
    const key = platform.toLowerCase();
    const adapter = this.registry.get(key);
    if (!adapter) {
      throw new Error(`No provisioner registered for platform "${platform}"`);
    }
    return adapter;
  }

  tryGet(platform: string): PlatformAdapter | null {
    const key = platform.toLowerCase();
    return this.registry.get(key) ?? null;
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
