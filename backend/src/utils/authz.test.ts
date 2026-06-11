import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../config/prisma';
import { AuthenticatedUser } from '../middleware/auth.middleware';
import {
  isSuperAdmin,
  isPlatformAdminOf,
  isGroupAdminOf,
  isAnyAdmin,
  getManageablePlatforms,
  getDirectGroupAdminSlugs,
  computeAdminScopes,
} from './authz';

describe('Authorization Helpers (authz.ts)', () => {
  // Test users
  let superAdminUser: AuthenticatedUser;
  let regularUser: AuthenticatedUser;
  let platformAdminUser: AuthenticatedUser;
  let groupAdminUser: AuthenticatedUser;

  let mockGroupRedash: any;
  let mockGroupAws: any;

  beforeEach(async () => {
    superAdminUser = {
      id: 'usr-super',
      username: 'super.admin',
      email: 'super@bachatt.app',
      roles: ['hermes_super_admin'],
    };

    regularUser = {
      id: 'usr-regular',
      username: 'regular.user',
      email: 'regular@bachatt.app',
      roles: [],
    };

    platformAdminUser = {
      id: 'usr-plat',
      username: 'plat.admin',
      email: 'plat@bachatt.app',
      roles: [],
    };

    groupAdminUser = {
      id: 'usr-group',
      username: 'group.admin',
      email: 'group@bachatt.app',
      roles: [],
    };
    // Seed groups
    mockGroupRedash = await prisma.group.create({
      data: {
        name: 'Growth Redash',
        slug: 'growth-redash',
        description: 'Redash Growth team access',
        platform: 'redash',
        externalGroupId: 'ext-grp-redash',
      },
    });

    mockGroupAws = await prisma.group.create({
      data: {
        name: 'Growth AWS',
        slug: 'growth-aws',
        description: 'AWS Growth team access',
        platform: 'aws',
        externalGroupId: 'ext-grp-aws',
      },
    });

    // Seed platform admin
    await prisma.platformAdmin.create({
      data: {
        userId: platformAdminUser.id,
        userName: platformAdminUser.username,
        userEmail: platformAdminUser.email,
        platform: 'redash',
        assignedBy: 'system',
      },
    });

    // Seed group admin
    await prisma.groupAdmin.create({
      data: {
        userId: groupAdminUser.id,
        userName: groupAdminUser.username,
        userEmail: groupAdminUser.email,
        groupId: mockGroupAws.id,
        assignedBy: 'system',
      },
    });
  });

  describe('isSuperAdmin', () => {
    it('should return true if the user has the super admin role', () => {
      expect(isSuperAdmin(superAdminUser)).toBe(true);
    });

    it('should return false if the user does not have the super admin role', () => {
      expect(isSuperAdmin(regularUser)).toBe(false);
      expect(isSuperAdmin(platformAdminUser)).toBe(false);
      expect(isSuperAdmin(groupAdminUser)).toBe(false);
    });
  });

  describe('isPlatformAdminOf', () => {
    it('should return true for super admins on any platform', async () => {
      expect(await isPlatformAdminOf(superAdminUser, 'redash')).toBe(true);
      expect(await isPlatformAdminOf(superAdminUser, 'aws')).toBe(true);
    });

    it('should return true if the user is a platform admin of that specific platform', async () => {
      expect(await isPlatformAdminOf(platformAdminUser, 'redash')).toBe(true);
    });

    it('should return false if the user is a platform admin of another platform', async () => {
      expect(await isPlatformAdminOf(platformAdminUser, 'aws')).toBe(false);
    });

    it('should return false for regular users', async () => {
      expect(await isPlatformAdminOf(regularUser, 'redash')).toBe(false);
    });
  });

  describe('isGroupAdminOf', () => {
    it('should return true for super admins on any group', async () => {
      expect(await isGroupAdminOf(superAdminUser, mockGroupRedash.id)).toBe(true);
      expect(await isGroupAdminOf(superAdminUser, mockGroupAws.id)).toBe(true);
    });

    it('should return true if the user is direct group admin of that specific group', async () => {
      expect(await isGroupAdminOf(groupAdminUser, mockGroupAws.id)).toBe(true);
    });

    it('should return false if the user is direct group admin of another group', async () => {
      expect(await isGroupAdminOf(groupAdminUser, mockGroupRedash.id)).toBe(false);
    });

    it('should return true if the user is platform admin of the group platform', async () => {
      // platformAdminUser is Redash platform admin, so should manage Growth Redash group
      expect(await isGroupAdminOf(platformAdminUser, mockGroupRedash.id)).toBe(true);
    });

    it('should return false if the user is platform admin of another platform', async () => {
      expect(await isGroupAdminOf(platformAdminUser, mockGroupAws.id)).toBe(false);
    });

    it('should return false for regular users', async () => {
      expect(await isGroupAdminOf(regularUser, mockGroupAws.id)).toBe(false);
    });
  });

  describe('isAnyAdmin', () => {
    it('should return true for super admins', async () => {
      expect(await isAnyAdmin(superAdminUser)).toBe(true);
    });

    it('should return true for platform admins', async () => {
      expect(await isAnyAdmin(platformAdminUser)).toBe(true);
    });

    it('should return true for group admins', async () => {
      expect(await isAnyAdmin(groupAdminUser)).toBe(true);
    });

    it('should return false for regular users', async () => {
      expect(await isAnyAdmin(regularUser)).toBe(false);
    });
  });

  describe('getManageablePlatforms', () => {
    it('should return all registered platforms for super admin', async () => {
      const platforms = await getManageablePlatforms(superAdminUser);
      expect(platforms).toContain('redash');
      expect(platforms).toContain('aws');
    });

    it('should return only manageable platforms for platform admin', async () => {
      const platforms = await getManageablePlatforms(platformAdminUser);
      expect(platforms).toEqual(['redash']);
    });

    it('should return empty array for regular user', async () => {
      const platforms = await getManageablePlatforms(regularUser);
      expect(platforms).toEqual([]);
    });
  });

  describe('getDirectGroupAdminSlugs', () => {
    it('should return direct group slugs for group admin', async () => {
      const slugs = await getDirectGroupAdminSlugs(groupAdminUser);
      expect(slugs).toEqual(['growth-aws']);
    });

    it('should return empty array for super admin (handled specially in UI)', async () => {
      const slugs = await getDirectGroupAdminSlugs(superAdminUser);
      expect(slugs).toEqual([]);
    });
  });

  describe('computeAdminScopes', () => {
    it('should return correct scope for super admin', async () => {
      const scopes = await computeAdminScopes(superAdminUser);
      expect(scopes.superAdmin).toBe(true);
      expect(scopes.platforms).toContain('redash');
      expect(scopes.platforms).toContain('aws');
      expect(scopes.groups).toEqual([]);
    });

    it('should return correct scope for platform admin', async () => {
      const scopes = await computeAdminScopes(platformAdminUser);
      expect(scopes.superAdmin).toBe(false);
      expect(scopes.platforms).toEqual(['redash']);
      // platform admin should auto-inherit groups on that platform
      expect(scopes.groups).toContain('growth-redash');
      expect(scopes.groups).not.toContain('growth-aws');
    });

    it('should return correct scope for group admin', async () => {
      const scopes = await computeAdminScopes(groupAdminUser);
      expect(scopes.superAdmin).toBe(false);
      expect(scopes.platforms).toEqual([]);
      expect(scopes.groups).toEqual(['growth-aws']);
    });

    it('should return empty scope for regular user', async () => {
      const scopes = await computeAdminScopes(regularUser);
      expect(scopes.superAdmin).toBe(false);
      expect(scopes.platforms).toEqual([]);
      expect(scopes.groups).toEqual([]);
    });
  });
});
