import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Request, Response } from 'express';
import { ProvisioningRegistry } from '../services/provisioning.registry';
import provisioningRegistry from '../services/provisioning.registry';
import { createRedashProvisioner } from '../services/redash.provisioner';
import { getRedashService } from '../services/redash.service';
import PlatformController from '../controllers/platform.controller';

/**
 * Covers the Redash multi-instance feature (prod + QA registered as separate
 * platform keys sharing a "family"): the provisioner factory's displayName
 * convention, the registry's opt-in registration of additional instances, and
 * the family/label fallback surfaced by GET /api/platforms.
 */
describe('Redash multi-instance provisioning', () => {
  describe('createRedashProvisioner', () => {
    it('names the prod instance "Redash" (no label suffix)', () => {
      const service = getRedashService({
        key: 'redash-test-prod',
        baseUrl: 'http://prod.example',
        apiKey: 'k',
        isSimulation: true,
      });
      const provisioner = createRedashProvisioner({
        key: 'redash-test-prod',
        family: 'redash',
        label: 'Prod',
        service,
      });

      expect(provisioner.platform).toBe('redash-test-prod');
      expect(provisioner.displayName).toBe('Redash');
      expect(provisioner.family).toBe('redash');
      expect(provisioner.label).toBe('Prod');
    });

    it('suffixes a non-prod instance\'s displayName with its label', () => {
      const service = getRedashService({
        key: 'redash-test-qa',
        baseUrl: 'http://qa.example',
        apiKey: 'k',
        isSimulation: true,
      });
      const provisioner = createRedashProvisioner({
        key: 'redash-test-qa',
        family: 'redash',
        label: 'QA',
        service,
      });

      expect(provisioner.platform).toBe('redash-test-qa');
      expect(provisioner.displayName).toBe('Redash (QA)');
      expect(provisioner.family).toBe('redash');
      expect(provisioner.label).toBe('QA');
    });
  });

  describe('ProvisioningRegistry instance registration', () => {
    const ENV_KEYS = ['REDASH_QA_BASE_URL', 'REDASH_QA_API_KEY', 'REDASH_QA_SIMULATION'] as const;
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of ENV_KEYS) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    });

    it('always registers prod redash, family "redash" / label "Prod"', () => {
      const registry = new ProvisioningRegistry();
      expect(registry.has('redash')).toBe(true);
      const prod = registry.get('redash');
      expect(prod.family).toBe('redash');
      expect(prod.label).toBe('Prod');
    });

    it('skips redash-qa when no base URL is configured', () => {
      const registry = new ProvisioningRegistry();
      expect(registry.has('redash-qa')).toBe(false);
      expect(registry.listPlatforms()).not.toContain('redash-qa');
    });

    it('registers redash-qa alongside prod when REDASH_QA_BASE_URL is configured', () => {
      process.env.REDASH_QA_BASE_URL = 'http://localhost:5501';
      process.env.REDASH_QA_API_KEY = 'test-qa-key';
      process.env.REDASH_QA_SIMULATION = 'true';

      const registry = new ProvisioningRegistry();
      expect(registry.has('redash')).toBe(true);
      expect(registry.has('redash-qa')).toBe(true);

      const qa = registry.get('redash-qa');
      expect(qa.family).toBe('redash');
      expect(qa.label).toBe('QA');
      expect(qa.displayName).toBe('Redash (QA)');
    });
  });
  describe('PlatformController family/label mapping', () => {
    const testKeys = ['test-fake-a', 'test-fake-b'];

    function makeReqRes() {
      const state = { data: null as any };
      const req = {} as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockImplementation((data) => {
          state.data = data;
        }),
      } as unknown as Response;
      const next = vi.fn();
      return { req, res, next, state };
    }

    afterEach(() => {
      vi.restoreAllMocks();
      for (const key of testKeys) {
        provisioningRegistry.unregister(key);
      }
    });

    it('surfaces an adapter\'s own family/label when set', async () => {
      const fakeAdapter = {
        platform: 'test-fake-a',
        displayName: 'Fake A',
        family: 'fake-family',
        label: 'Beta',
        healthCheck: vi.fn(),
      };
      provisioningRegistry.register('test-fake-a', fakeAdapter as any);

      const { req, res, next, state } = makeReqRes();
      await new PlatformController(req, res, next).list(req, res, next);

      const entry = state.data.data.platforms.find((p: any) => p.key === 'test-fake-a');
      expect(entry).toBeDefined();
      expect(entry.family).toBe('fake-family');
      expect(entry.label).toBe('Beta');
    });

    it('defaults family to the platform key and label to null when unset', async () => {
      const fakeAdapter = {
        platform: 'test-fake-b',
        displayName: 'Fake B',
        healthCheck: vi.fn(),
      };
      provisioningRegistry.register('test-fake-b', fakeAdapter as any);

      const { req, res, next, state } = makeReqRes();
      await new PlatformController(req, res, next).list(req, res, next);

      const entry = state.data.data.platforms.find((p: any) => p.key === 'test-fake-b');
      expect(entry).toBeDefined();
      expect(entry.family).toBe('test-fake-b');
      expect(entry.label).toBeNull();
    });
  });
});
