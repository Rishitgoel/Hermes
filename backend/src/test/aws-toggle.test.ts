import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import config from '../config/config';
import awsProvisioner from '../services/aws.provisioner';
import syncService from '../services/sync.service';
import PlatformController from '../controllers/platform.controller';
import UserCreationController from '../controllers/user-creation.controller';
import userCreationService from '../services/user-creation.service';
import prisma from '../config/prisma';
import { getManageablePlatforms } from '../utils/authz';
import { AuthenticatedUser } from '../middleware/auth.middleware';
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

  describe('Admin Management (getManageablePlatforms) honors the toggle', () => {
    // Super admin path reads straight from the provisioning registry — no DB
    // needed — so it exercises the filter without Testcontainers.
    const superAdmin: AuthenticatedUser = {
      id: 'usr-super',
      username: 'super.admin',
      email: 'super@bachatt.app',
      roles: ['hermes_super_admin'],
    };

    it('should exclude AWS for a super admin when disabled', async () => {
      process.env.AWS_ENABLED = 'false';
      const platforms = await getManageablePlatforms(superAdmin);
      expect(platforms).not.toContain('aws');
      expect(platforms).toContain('redash');
    });

    it('should include AWS for a super admin when enabled', async () => {
      process.env.AWS_ENABLED = 'true';
      const platforms = await getManageablePlatforms(superAdmin);
      expect(platforms).toContain('aws');
      expect(platforms).toContain('redash');
    });

    it('should include AWS for a super admin by default (unset)', async () => {
      // beforeEach deletes AWS_ENABLED, so this is the default case.
      const platforms = await getManageablePlatforms(superAdmin);
      expect(platforms).toContain('aws');
    });
  });

  describe('Pending Approvals (UserCreationController) honors the toggle', () => {
    const superAdmin: AuthenticatedUser = {
      id: 'usr-super',
      username: 'super.admin',
      email: 'super@bachatt.app',
      roles: ['hermes_super_admin'],
    };

    function makeRes() {
      const state = { data: null as any, status: 200 };
      const res = {
        status: vi.fn().mockImplementation((c: number) => {
          state.status = c;
          return res;
        }),
        json: vi.fn().mockImplementation((d: any) => {
          state.data = d;
        }),
      } as unknown as Response;
      return { res, state };
    }

    it('listPending scopes a super admin to enabled platforms (no AWS) when disabled', async () => {
      process.env.AWS_ENABLED = 'false';
      const spy = vi.spyOn(userCreationService, 'listPending').mockResolvedValue([] as any);
      const req = { user: superAdmin, query: {}, params: {}, body: {} } as unknown as Request;
      const { res } = makeRes();

      const controller = new UserCreationController(req, res, vi.fn());
      await controller.listPending(req, res, vi.fn());

      expect(spy).toHaveBeenCalledTimes(1);
      const platformsArg = spy.mock.calls[0][0];
      expect(platformsArg).toBeDefined();
      expect(platformsArg).not.toContain('aws');
      expect(platformsArg).toContain('redash');
    });

    it('listPending still includes AWS for a super admin when enabled', async () => {
      process.env.AWS_ENABLED = 'true';
      const spy = vi.spyOn(userCreationService, 'listPending').mockResolvedValue([] as any);
      const req = { user: superAdmin, query: {}, params: {}, body: {} } as unknown as Request;
      const { res } = makeRes();

      const controller = new UserCreationController(req, res, vi.fn());
      await controller.listPending(req, res, vi.fn());

      const platformsArg = spy.mock.calls[0][0];
      expect(platformsArg).toContain('aws');
    });

    it('review() rejects an AWS request when AWS is disabled, even for a super admin', async () => {
      process.env.AWS_ENABLED = 'false';
      vi.spyOn(prisma.userCreationRequest, 'findUnique').mockResolvedValue({ platform: 'aws' } as any);
      const reviewSpy = vi.spyOn(userCreationService, 'reviewRequest').mockResolvedValue({} as any);
      const req = {
        user: superAdmin,
        query: {},
        params: { id: 'ucr-1' },
        body: { status: 'APPROVED' },
      } as unknown as Request;
      const { res, state } = makeRes();

      const controller = new UserCreationController(req, res, vi.fn());
      await controller.review(req, res, vi.fn());

      expect(reviewSpy).not.toHaveBeenCalled();
      expect(state.status).toBe(403);
      expect(state.data.success).toBe(false);
    });

    it('review() allows an AWS request when AWS is enabled', async () => {
      process.env.AWS_ENABLED = 'true';
      vi.spyOn(prisma.userCreationRequest, 'findUnique').mockResolvedValue({ platform: 'aws' } as any);
      const reviewSpy = vi.spyOn(userCreationService, 'reviewRequest').mockResolvedValue({} as any);
      const req = {
        user: superAdmin,
        query: {},
        params: { id: 'ucr-1' },
        body: { status: 'APPROVED' },
      } as unknown as Request;
      const { res } = makeRes();

      const controller = new UserCreationController(req, res, vi.fn());
      await controller.review(req, res, vi.fn());

      expect(reviewSpy).toHaveBeenCalledTimes(1);
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
