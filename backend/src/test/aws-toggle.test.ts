import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import config from '../config/config';
import awsProvisioner from '../services/aws.provisioner';
import syncService from '../services/sync.service';
import PlatformController from '../controllers/platform.controller';
import { Request, Response } from 'express';

describe('AWS Enable/Disable toggle', () => {
  const originalEnv = process.env.AWS_ENABLED;

  beforeEach(() => {
    // Reset env before each test
    delete process.env.AWS_ENABLED;
  });

  afterEach(() => {
    // Restore original env after tests
    process.env.AWS_ENABLED = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Configuration (config.aws.isEnabled)', () => {
    it('should default to true if process.env.AWS_ENABLED is undefined', () => {
      expect(config.aws.isEnabled).toBe(true);
    });

    it('should be true if process.env.AWS_ENABLED is not "false"', () => {
      process.env.AWS_ENABLED = 'true';
      expect(config.aws.isEnabled).toBe(true);
      
      process.env.AWS_ENABLED = 'random-value';
      expect(config.aws.isEnabled).toBe(true);
    });

    it('should be false if process.env.AWS_ENABLED is "false"', () => {
      process.env.AWS_ENABLED = 'false';
      expect(config.aws.isEnabled).toBe(false);
    });
  });

  describe('AwsProvisioner behavior when disabled', () => {
    beforeEach(() => {
      process.env.AWS_ENABLED = 'false';
    });

    it('should throw an error on provision()', async () => {
      await expect(
        awsProvisioner.provision({
          email: 'test@example.com',
          name: 'Test User',
        })
      ).rejects.toThrow('AWS integration is currently disabled');
    });

    it('should throw an error on deprovision()', async () => {
      await expect(
        awsProvisioner.deprovision({
          externalUserId: 'user-123',
          email: 'test@example.com',
        })
      ).rejects.toThrow('AWS integration is currently disabled');
    });

    it('should throw an error on inviteUser()', async () => {
      await expect(
        awsProvisioner.inviteUser('test@example.com', 'Test User')
      ).rejects.toThrow('AWS integration is currently disabled');
    });

    it('should throw an error on createExternalGroup()', async () => {
      await expect(
        awsProvisioner.createExternalGroup('Test Group')
      ).rejects.toThrow('AWS integration is currently disabled');
    });

    it('should throw an error on deleteExternalGroup()', async () => {
      await expect(
        awsProvisioner.deleteExternalGroup('group-123')
      ).rejects.toThrow('AWS integration is currently disabled');
    });

    it('should return false or empty count on sync/lookups instead of executing', async () => {
      expect(await awsProvisioner.checkUserStatus('test@example.com')).toEqual({
        exists: false,
        email: 'test@example.com',
      });
      expect(await awsProvisioner.syncGroups()).toEqual({ count: 0 });
      expect(await awsProvisioner.syncUsers()).toEqual({ count: 0 });
      expect(await awsProvisioner.syncSingleUser('test@example.com')).toBe(false);
    });
  });

  describe('PlatformController behavior when disabled', () => {
    it('should filter out AWS from platforms when disabled', async () => {
      process.env.AWS_ENABLED = 'false';
      
      let responseData: any = null;
      const req = {} as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockImplementation((data) => {
          responseData = data;
        }),
      } as unknown as Response;
      const next = vi.fn();

      const controller = new PlatformController(req, res, next);
      await controller.list(req, res, next);

      expect(responseData).toBeDefined();
      expect(responseData.success).toBe(true);
      expect(responseData.data.live).not.toContain('aws');
      expect(responseData.data.platforms.map((p: any) => p.key)).not.toContain('aws');
      expect(responseData.data.live).toContain('redash');
    });

    it('should include AWS in platforms when enabled', async () => {
      process.env.AWS_ENABLED = 'true';
      
      let responseData: any = null;
      const req = {} as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockImplementation((data) => {
          responseData = data;
        }),
      } as unknown as Response;
      const next = vi.fn();

      const controller = new PlatformController(req, res, next);
      await controller.list(req, res, next);

      expect(responseData).toBeDefined();
      expect(responseData.success).toBe(true);
      expect(responseData.data.live).toContain('aws');
      expect(responseData.data.platforms.map((p: any) => p.key)).toContain('aws');
      expect(responseData.data.live).toContain('redash');
    });
  });

  describe('SyncService behavior when disabled', () => {
    it('should not perform sync on AWS when disabled', async () => {
      process.env.AWS_ENABLED = 'false';

      // Mock syncSinglePlatform to monitor what is called
      const syncSingleSpy = vi.spyOn(syncService, 'syncSinglePlatform');
      
      await syncService.syncAllPlatforms();

      // Ensure redash is synced but aws is not
      expect(syncSingleSpy).toHaveBeenCalledWith('redash');
      expect(syncSingleSpy).not.toHaveBeenCalledWith('aws');
    });
  });
});
