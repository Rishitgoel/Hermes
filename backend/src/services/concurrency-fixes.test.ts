import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../config/prisma';
import { ensureDefaultGroupMembership } from './default-membership.service';
import { AdminManagementController } from '../controllers/admin-management.controller';
import { Request, Response } from 'express';
import { ConflictError } from '../utils/errors';

describe('Phase 3 Concurrency & Atomicity Tests', () => {
  describe('ensureDefaultGroupMembership', () => {
    const PLATFORM = 'redash';

    beforeEach(async () => {
      // Clean up user access & group rows between tests
      await prisma.userAccess.deleteMany();
      await prisma.group.deleteMany();
      await prisma.platformExternalGroup.deleteMany();
    });

    it('is idempotent and swallows P2002 errors when called concurrently for same default membership', async () => {
      // 1. Create a platform external group named 'default'
      const extGroup = await prisma.platformExternalGroup.create({
        data: {
          platform: PLATFORM,
          externalId: 'ext-default-1',
          name: 'default',
          type: 'builtin',
          lastSyncedAt: new Date(),
        },
      });

      // 2. Create the backing Hermes group
      const group = await prisma.group.create({
        data: {
          name: 'Default Group',
          slug: 'default-gp',
          description: 'built-in default group',
          platform: PLATFORM,
          externalGroupId: extGroup.externalId,
          tables: [],
        },
      });

      const user = {
        userId: 'usr-default-test',
        userName: 'Default Test User',
        userEmail: 'default@bachatt.app',
      };

      // 3. Call ensureDefaultGroupMembership twice concurrently/simultaneously to simulate a race.
      const p1 = ensureDefaultGroupMembership(PLATFORM, user);
      const p2 = ensureDefaultGroupMembership(PLATFORM, user);

      // Both should resolve without throwing any unique constraint P2002 errors.
      await expect(Promise.all([p1, p2])).resolves.toBeDefined();

      // Only 1 userAccess row should exist in the database.
      const grants = await prisma.userAccess.findMany({
        where: { userId: user.userId, groupId: group.id },
      });
      expect(grants).toHaveLength(1);
    });
  });

  describe('AdminManagementController.deleteGroup force branch', () => {
    let responseData: any = null;
    let statusValue = 200;

    const mockRes = {
      status: vi.fn().mockImplementation((code) => {
        statusValue = code;
        return mockRes;
      }),
      json: vi.fn().mockImplementation((data) => {
        responseData = data;
      }),
    } as unknown as Response;

    const mockNext = vi.fn();

    beforeEach(async () => {
      responseData = null;
      statusValue = 200;
      await prisma.userAccess.deleteMany();
      await prisma.group.deleteMany();
    });

    it('checks active members inside transaction and prevents stranding concurrent grants', async () => {
      // Create a group
      const group = await prisma.group.create({
        data: {
          name: 'To Delete',
          slug: 'to-delete',
          description: '',
          platform: 'redash',
          externalGroupId: 'ext-del-1',
          tables: [],
        },
      });

      // Create an active grant on the group
      await prisma.userAccess.create({
        data: {
          userId: 'usr-active',
          userName: 'Active User',
          userEmail: 'active@bachatt.app',
          groupId: group.id,
          isActive: true,
          grantedBy: 'test',
        },
      });

      const mockReq = {
        params: { groupId: group.id },
        query: { force: 'true' },
        body: {},
      } as unknown as Request;

      const controller = new AdminManagementController(mockReq, mockRes, mockNext);
      controller.user = {
        id: 'usr-super',
        username: 'super.admin',
        email: 'super@bachatt.app',
        roles: ['hermes_super_admin'],
      };

      // Deleting a group with active members must fail, write status 409, and return error json
      await controller.deleteGroup(mockReq, mockRes, mockNext);
      expect(statusValue).toBe(409);
      expect(responseData).toMatchObject({
        success: false,
        error: expect.stringMatching(/active member/),
      });

      // Group should still exist
      const foundGroup = await prisma.group.findUnique({ where: { id: group.id } });
      expect(foundGroup).not.toBeNull();
    });
  });
});
