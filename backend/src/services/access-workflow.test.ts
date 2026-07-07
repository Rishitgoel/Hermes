import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import prisma from '../config/prisma';
import { accessWorkflowService } from './access-workflow.service';
import { userCreationService } from './user-creation.service';
import provisioningRegistry from './provisioning.registry';
import { AccessDuration, RequestStatus, UserCreationStatus } from '../../generated/hermes';
import { ConflictError, UserNotApprovedError } from '../utils/errors';
import config from '../config/config';
  
describe('AccessWorkflowService Integration Tests', () => {
  const testUser = {
    id: 'usr-test',
    username: 'test.user',
    email: 'test@bachatt.app',
  };

  const adminUser = {
    id: 'usr-admin',
    username: 'admin.user',
  };

  // Mock Provisioners
  const mockRedashInviteLink = `${config.redash.baseUrl.replace(/\/$/, '')}/invite/token123`;
  let _deprovisionCallCount = 0;
  let deprovisionShouldThrow = false;

  const mockRedashAdapter = {
    platform: 'redash',
    provision: vi.fn().mockResolvedValue({ externalUserId: 'ext-redash-123' }),
    deprovision: vi.fn(async () => {
      _deprovisionCallCount++;
      if (deprovisionShouldThrow) {
        throw new Error('Deprovision failed');
      }
    }),
    checkUserStatus: vi.fn().mockResolvedValue({ exists: true }),
    inviteUser: vi.fn().mockResolvedValue({
      externalUserId: 'ext-redash-123',
      metadata: { inviteLink: mockRedashInviteLink },
    }),
    regenerateInvite: vi.fn().mockResolvedValue({
      externalUserId: 'ext-redash-123',
      metadata: { inviteLink: mockRedashInviteLink },
    }),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  };

  const mockAwsAdapter = {
    platform: 'aws',
    provision: vi.fn().mockResolvedValue({ externalUserId: 'ext-aws-123' }),
    deprovision: vi.fn().mockResolvedValue(undefined),
    checkUserStatus: vi.fn().mockResolvedValue({ exists: true }),
    inviteUser: vi.fn().mockResolvedValue({
      externalUserId: 'ext-aws-123',
      metadata: {}, // no invite link for AWS, completes instantly
    }),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  };

  beforeEach(async () => {
    _deprovisionCallCount = 0;
    deprovisionShouldThrow = false;
    vi.clearAllMocks();

    // Register our test mock provisioners
    provisioningRegistry.register('redash', mockRedashAdapter as any);
    provisioningRegistry.register('aws', mockAwsAdapter as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('calculateExpiry Unit Tests', () => {
    it('should map durations correctly to dates', () => {
      vi.useFakeTimers();
      const nowMs = 1718064000000; // June 11, 2026
      vi.setSystemTime(new Date(nowMs));

      // 1 Day = 24 hours
      const expiryOneDay = accessWorkflowService['calculateExpiry'](AccessDuration.ONE_DAY);
      expect(expiryOneDay?.getTime()).toBe(nowMs + 24 * 60 * 60 * 1000);

      // 1 Week = 7 days
      const expiryOneWeek = accessWorkflowService['calculateExpiry'](AccessDuration.ONE_WEEK);
      expect(expiryOneWeek?.getTime()).toBe(nowMs + 7 * 24 * 60 * 60 * 1000);

      // Clamped months
      const expiryOneMonth = accessWorkflowService['calculateExpiry'](AccessDuration.ONE_MONTH);
      const expectedOneMonth = new Date(nowMs);
      expectedOneMonth.setMonth(expectedOneMonth.getMonth() + 1);
      expect(expiryOneMonth?.getTime()).toBe(expectedOneMonth.getTime());

      const expiryPermanent = accessWorkflowService['calculateExpiry'](AccessDuration.PERMANENT);
      expect(expiryPermanent).toBeNull();
    });

    it('should clamp date additions to prevent month overshoot', () => {
      vi.useFakeTimers();
      // Jan 31, 2026
      vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));
      
      const expiryOneMonth = accessWorkflowService['calculateExpiry'](AccessDuration.ONE_MONTH);
      // Jan 31 + 1 month clamps back to Feb 28, 2026 (not Mar 3)
      expect(expiryOneMonth?.toISOString().slice(0, 10)).toBe('2026-02-28');
    });
  });

  describe('Happy-Path Access Request Lifecycle', () => {
    let group: any;

    beforeEach(async () => {
      group = await prisma.group.create({
        data: {
          name: 'Core Operations',
          slug: 'core-ops',
          description: 'Access to core ops',
          platform: 'redash',
          externalGroupId: 'ext-group-ops',
        },
      });

      // User must have completed platform user-creation to get access approved
      await prisma.userCreationRequest.create({
        data: {
          userId: testUser.id,
          userName: testUser.username,
          userEmail: testUser.email,
          platform: 'redash',
          status: UserCreationStatus.COMPLETED,
        },
      });
    });

    it('should go through request -> approve -> expire sequence successfully', async () => {
      // 1. Submit request
      const req = await accessWorkflowService.createRequest(
        testUser,
        group.id,
        'Need it for query logs',
        AccessDuration.ONE_DAY,
      );

      expect(req.status).toBe(RequestStatus.PENDING);
      expect(req.justification).toBe('Need it for query logs');
      expect(req.expiresAt).not.toBeNull();

      // Check request audit log
      const auditCreated = await prisma.auditEntry.findFirst({
        where: { action: 'REQUEST_CREATED', accessRequestId: req.id },
      });
      expect(auditCreated).toBeDefined();
      expect(auditCreated?.performerId).toBe(testUser.id);

      // 2. Approve request
      const approvedReq = await accessWorkflowService.reviewRequest(
        req.id,
        adminUser,
        'APPROVED',
        'Looks good to me',
      );

      expect(approvedReq.status).toBe(RequestStatus.PROVISIONED);
      expect(mockRedashAdapter.provision).toHaveBeenCalledWith({
        email: testUser.email,
        name: testUser.username,
        userId: testUser.id,
        externalGroupId: group.externalGroupId,
        metadata: { groupSlug: group.slug, levelSlug: null },
      });

      // Verify UserAccess row exists
      const userAccess = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });
      expect(userAccess).not.toBeNull();
      expect(userAccess?.grantedBy).toBe(adminUser.username);

      // Check approval audit log
      const auditApproved = await prisma.auditEntry.findFirst({
        where: { action: 'ACCESS_GRANTED', accessRequestId: req.id },
      });
      expect(auditApproved).not.toBeNull();
      expect(auditApproved?.performerId).toBe(adminUser.id);

      // 3. Expire access
      await accessWorkflowService.expireAccess(userAccess!.id);

      // Verify UserAccess is deactivated
      const userAccessDeactivated = await prisma.userAccess.findUnique({
        where: { id: userAccess!.id },
      });
      expect(userAccessDeactivated?.isActive).toBe(false);
      expect(userAccessDeactivated?.revokedAt).not.toBeNull();

      // Verify request is expired
      const reqExpired = await prisma.accessRequest.findUnique({
        where: { id: req.id },
      });
      expect(reqExpired?.status).toBe(RequestStatus.EXPIRED);

      // Verify deprovision called on provisioner
      expect(mockRedashAdapter.deprovision).toHaveBeenCalledWith({
        externalUserId: 'ext-redash-123',
        externalGroupId: group.externalGroupId,
      });

      // Check expiry audit log
      const auditExpired = await prisma.auditEntry.findFirst({
        where: { action: 'ACCESS_EXPIRED', targetUserId: testUser.id },
      });
      expect(auditExpired).not.toBeNull();
    });

    it('warnExpiringAccess marks the grant warned once and is a no-op on a second call', async () => {
      const req = await accessWorkflowService.createRequest(
        testUser,
        group.id,
        null,
        'Need it for query logs',
        AccessDuration.ONE_DAY,
      );
      await accessWorkflowService.reviewRequest(req.id, adminUser, 'APPROVED', 'Looks good to me');

      const userAccess = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });
      expect(userAccess?.expiryWarnedAt).toBeNull();

      await accessWorkflowService.warnExpiringAccess(userAccess!.id);
      const warned = await prisma.userAccess.findUnique({ where: { id: userAccess!.id } });
      expect(warned?.expiryWarnedAt).not.toBeNull();
      expect(warned?.isActive).toBe(true); // warning never touches the grant's active state

      // Second call is a no-op: the timestamp does not move.
      const firstWarnedAt = warned!.expiryWarnedAt;
      await accessWorkflowService.warnExpiringAccess(userAccess!.id);
      const warnedAgain = await prisma.userAccess.findUnique({ where: { id: userAccess!.id } });
      expect(warnedAgain?.expiryWarnedAt?.getTime()).toBe(firstWarnedAt!.getTime());
    });

    it('warnExpiringAccess is a no-op for a grant that is already inactive', async () => {
      const req = await accessWorkflowService.createRequest(
        testUser,
        group.id,
        null,
        'Need it for query logs',
        AccessDuration.ONE_DAY,
      );
      await accessWorkflowService.reviewRequest(req.id, adminUser, 'APPROVED', 'Looks good to me');

      const userAccess = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });
      await accessWorkflowService.expireAccess(userAccess!.id);

      await accessWorkflowService.warnExpiringAccess(userAccess!.id);
      const afterWarn = await prisma.userAccess.findUnique({ where: { id: userAccess!.id } });
      expect(afterWarn?.expiryWarnedAt).toBeNull();
    });
  });

  describe('Failure Paths & Invariant Protections', () => {
    let group: any;

    beforeEach(async () => {
      group = await prisma.group.create({
        data: {
          name: 'Core Operations',
          slug: 'core-ops',
          description: 'Access to core ops',
          platform: 'redash',
          externalGroupId: 'ext-group-ops',
        },
      });
    });

    it('should throw ConflictError if request already pending or access active', async () => {
      // Create user-creation completed row
      await prisma.userCreationRequest.create({
        data: {
          userId: testUser.id,
          userName: testUser.username,
          userEmail: testUser.email,
          platform: 'redash',
          status: UserCreationStatus.COMPLETED,
        },
      });

      // First request
      await accessWorkflowService.createRequest(
        testUser,
        group.id,
        'Justification 1',
        AccessDuration.ONE_DAY,
      );

      // Duplicate request -> should throw ConflictError
      await expect(
        accessWorkflowService.createRequest(
          testUser,
          group.id,
          'Justification 2',
          AccessDuration.ONE_DAY,
        ),
      ).rejects.toThrow(ConflictError);
    });

    it('should throw UserNotApprovedError if user platform account is not approved or completed', async () => {
      const req = await accessWorkflowService.createRequest(
        testUser,
        group.id,
        'Justification',
        AccessDuration.ONE_DAY,
      );

      // No UserCreationRequest seeded -> should throw UserNotApprovedError
      await expect(
        accessWorkflowService.reviewRequest(req.id, adminUser, 'APPROVED'),
      ).rejects.toThrow(UserNotApprovedError);
    });

    it('should handle deprovision failures and retry up to limit, then force expire', async () => {
      await prisma.userCreationRequest.create({
        data: {
          userId: testUser.id,
          userName: testUser.username,
          userEmail: testUser.email,
          platform: 'redash',
          status: UserCreationStatus.COMPLETED,
        },
      });

      const req = await accessWorkflowService.createRequest(testUser, group.id, 'Test', AccessDuration.ONE_DAY);
      await accessWorkflowService.reviewRequest(req.id, adminUser, 'APPROVED');

      const userAccess = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });

      // Force deprovision calls to throw
      deprovisionShouldThrow = true;

      // Attempt 1: throws and stays active
      await expect(accessWorkflowService.expireAccess(userAccess!.id)).rejects.toThrow('Deprovision failed');
      let accessState = await prisma.userAccess.findUnique({ where: { id: userAccess!.id } });
      expect(accessState?.isActive).toBe(true);
      expect(accessState?.expiryAttempts).toBe(1);

      // Attempt 2: throws and stays active
      await expect(accessWorkflowService.expireAccess(userAccess!.id)).rejects.toThrow('Deprovision failed');
      accessState = await prisma.userAccess.findUnique({ where: { id: userAccess!.id } });
      expect(accessState?.isActive).toBe(true);
      expect(accessState?.expiryAttempts).toBe(2);

      // Attempt 3: force expires and doesn't throw
      await accessWorkflowService.expireAccess(userAccess!.id);
      accessState = await prisma.userAccess.findUnique({ where: { id: userAccess!.id } });
      expect(accessState?.isActive).toBe(false);
      expect(accessState?.expiryAttempts).toBe(3);

      // Request status is updated to EXPIRED with failure message
      const updatedReq = await prisma.accessRequest.findUnique({ where: { id: req.id } });
      expect(updatedReq?.status).toBe(RequestStatus.EXPIRED);
      expect(updatedReq?.revokeReason).toContain('Auto-expiry failed after 3 attempts');

      // Check audit entry for fail flag
      const auditFailed = await prisma.auditEntry.findFirst({
        where: { action: 'ACCESS_EXPIRY_FAILED' },
      });
      expect(auditFailed).not.toBeNull();
    });

    it('revokeAccess succeeds when the platform deprovision is a no-op (membership already gone)', async () => {
      await prisma.userCreationRequest.create({
        data: {
          userId: testUser.id,
          userName: testUser.username,
          userEmail: testUser.email,
          platform: 'redash',
          status: UserCreationStatus.COMPLETED,
        },
      });

      const req = await accessWorkflowService.createRequest(testUser, group.id, 'Test', AccessDuration.PERMANENT);
      await accessWorkflowService.reviewRequest(req.id, adminUser, 'APPROVED');

      const userAccess = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });

      // A user removed from the group (or deleted) directly on Redash surfaces as an
      // idempotent no-op from the adapter's deprovision (removeUserFromGroup tolerates
      // a 404), NOT a throw — so revoke completes cleanly without any cache guessing.
      deprovisionShouldThrow = false;

      const revoked = await accessWorkflowService.revokeAccess(userAccess!.id, adminUser, 'cleanup');
      expect(revoked.isActive).toBe(false);
      expect(revoked.revokedAt).not.toBeNull();

      const audit = await prisma.auditEntry.findFirst({
        where: { action: 'ACCESS_REVOKED', targetUserId: testUser.id },
      });
      expect(audit).not.toBeNull();
    });

    it('revokeAccess rolls back and re-throws when the platform deprovision fails for real', async () => {
      await prisma.userCreationRequest.create({
        data: {
          userId: testUser.id,
          userName: testUser.username,
          userEmail: testUser.email,
          platform: 'redash',
          status: UserCreationStatus.COMPLETED,
        },
      });

      const req = await accessWorkflowService.createRequest(testUser, group.id, 'Test', AccessDuration.PERMANENT);
      await accessWorkflowService.reviewRequest(req.id, adminUser, 'APPROVED');

      const userAccess = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });

      // A genuine (non-404) platform error must NOT silently drop the grant: roll back
      // the deactivation and surface the error so the user isn't left with platform
      // access Hermes believes is revoked.
      deprovisionShouldThrow = true;

      await expect(accessWorkflowService.revokeAccess(userAccess!.id, adminUser, 'cleanup')).rejects.toThrow('Deprovision failed');
      const stillActive = await prisma.userAccess.findUnique({ where: { id: userAccess!.id } });
      expect(stillActive?.isActive).toBe(true);
    });
  });

  describe('User-Creation Onboarding Flows', () => {
    it('should handle Redash setup-link pathway (AWAITING_SETUP -> COMPLETED on sync)', async () => {
      // 1. Submit account request
      let req = await userCreationService.submitRequest(testUser, 'I need Redash analytics access', 'redash');
      expect(req.status).toBe(UserCreationStatus.PENDING);

      // 2. Admin approves
      req = await userCreationService.reviewRequest(req.id, adminUser, 'APPROVED');
      // Redash returns a setup link, so status moves to AWAITING_SETUP
      expect(req.status).toBe(UserCreationStatus.AWAITING_SETUP);
      expect(req.inviteLink).toBe(mockRedashInviteLink);

      // Check audit entry
      const auditApproved = await prisma.auditEntry.findFirst({ where: { action: 'USER_CREATION_APPROVED' } });
      expect(auditApproved).not.toBeNull();

      // 3. User setup completes, simulated by sync detecting user (isPending becomes false)
      await userCreationService.handlePlatformUserDetected('redash', {
        externalId: 'ext-redash-123',
        email: testUser.email,
        isPending: false,
      });

      const finalizedReq = await prisma.userCreationRequest.findUnique({ where: { id: req.id } });
      expect(finalizedReq?.status).toBe(UserCreationStatus.COMPLETED);
      expect(finalizedReq?.inviteLink).toBeNull(); // Setup URL dropped once completed

      const auditCompleted = await prisma.auditEntry.findFirst({ where: { action: 'USER_CREATION_COMPLETED' } });
      expect(auditCompleted).not.toBeNull();
    });

    it('should handle AWS instant completion pathway (instant COMPLETED)', async () => {
      // 1. Submit AWS account request
      let req = await userCreationService.submitRequest(testUser, 'I need AWS SSO access', 'aws');
      expect(req.status).toBe(UserCreationStatus.PENDING);

      // 2. Admin approves
      req = await userCreationService.reviewRequest(req.id, adminUser, 'APPROVED');
      // AWS does not issue a setup link; account ready instantly. Status moves straight to COMPLETED.
      expect(req.status).toBe(UserCreationStatus.COMPLETED);
      expect(req.externalUserId).toBe('ext-aws-123');
    });

    it('should cascade reject pending group requests if account creation is rejected', async () => {
      const group = await prisma.group.create({
        data: {
          name: 'Core Operations',
          slug: 'core-ops',
          description: 'Access to core ops',
          platform: 'redash',
          externalGroupId: 'ext-group-ops',
        },
      });

      // Submit user account request
      const userReq = await userCreationService.submitRequest(testUser, 'Need redash access', 'redash');

      // Submit group request (allowed while user creation is pending)
      const groupReq = await accessWorkflowService.createRequest(testUser, group.id, 'Need group', AccessDuration.ONE_DAY);

      let groupReqState = await prisma.accessRequest.findUnique({ where: { id: groupReq.id } });
      expect(groupReqState?.status).toBe(RequestStatus.PENDING);

      // Reject account request
      await userCreationService.reviewRequest(userReq.id, adminUser, 'REJECTED', 'No analytics role');

      // Group request should be cascade-rejected
      groupReqState = await prisma.accessRequest.findUnique({ where: { id: groupReq.id } });
      expect(groupReqState?.status).toBe(RequestStatus.REJECTED);
      expect(groupReqState?.reviewerName).toContain('System (cascade reject)');
    });
  });

  describe('Level-Change promoting/demoting/swapping flows', () => {
    let group: any;
    let levelIntern: any;
    let levelJunior: any;
    let userAccess: any;

    beforeEach(async () => {
      group = await prisma.group.create({
        data: {
          name: 'Analytics Group',
          slug: 'analytics',
          description: 'Analytics Access',
          platform: 'redash',
          externalGroupId: 'ext-grp-base',
          icon: 'TrendingUp',
          color: '#4F46E5',
        },
      });

      levelIntern = await prisma.groupLevel.create({
        data: {
          groupId: group.id,
          name: 'Intern',
          slug: 'intern',
          rank: 0,
          externalGroupId: 'ext-grp-intern',
        },
      });

      levelJunior = await prisma.groupLevel.create({
        data: {
          groupId: group.id,
          name: 'Junior',
          slug: 'junior',
          rank: 1,
          externalGroupId: 'ext-grp-junior',
        },
      });

      await prisma.groupLevel.create({
        data: {
          groupId: group.id,
          name: 'Senior',
          slug: 'senior',
          rank: 2,
          externalGroupId: 'ext-grp-senior',
        },
      });

      // User account is COMPLETED
      await prisma.userCreationRequest.create({
        data: {
          userId: testUser.id,
          userName: testUser.username,
          userEmail: testUser.email,
          platform: 'redash',
          status: UserCreationStatus.COMPLETED,
        },
      });

      // Grant initial access at junior level
      const req = await accessWorkflowService.createRequest(
        testUser,
        group.id,
        'Seeded grant',
        AccessDuration.ONE_MONTH,
        levelJunior.id,
      );
      await accessWorkflowService.reviewRequest(req.id, adminUser, 'APPROVED');

      userAccess = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });
    });

    it('should change level immediately when admin calls adminSetMemberLevel', async () => {
      // Set current access to expire tomorrow (ensure system doesn't reset the timer)
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await prisma.userAccess.update({
        where: { id: userAccess.id },
        data: { expiresAt: tomorrow },
      });

      // Admin sets member level from Junior (rank 1) -> Intern (rank 0)
      const res = await accessWorkflowService.adminSetMemberLevel(
        adminUser,
        userAccess.id,
        levelIntern.id,
      );

      expect(res.status).toBe(RequestStatus.PROVISIONED);

      // Verify old grant is deactivated
      const oldGrant = await prisma.userAccess.findUnique({ where: { id: userAccess.id } });
      expect(oldGrant?.isActive).toBe(false);

      // Verify new grant is active at Intern level
      const newGrant = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });
      expect(newGrant).not.toBeNull();
      expect(newGrant?.levelId).toBe(levelIntern.id);
      // Expiry is re-applied from now, so it should be after tomorrow
      expect(newGrant?.expiresAt?.getTime()).toBeGreaterThan(tomorrow.getTime());

      // Deprovision called on old group, provision called on new group
      expect(mockRedashAdapter.deprovision).toHaveBeenCalledWith({
        externalUserId: 'ext-redash-123',
        externalGroupId: levelJunior.externalGroupId,
        retainExternalGroupId: levelIntern.externalGroupId,
      });
      expect(mockRedashAdapter.provision).toHaveBeenCalledWith({
        email: testUser.email,
        name: testUser.username,
        userId: testUser.id,
        externalGroupId: levelIntern.externalGroupId,
        metadata: { groupSlug: group.slug, levelSlug: levelIntern.slug },
      });

      // Verify audit entry logs level change
      const auditCreate = await prisma.auditEntry.findFirst({
        where: { action: 'REQUEST_CREATED', accessRequestId: res.id },
      });
      expect(auditCreate?.details).toMatchObject({
        adminSetLevel: true,
        fromLevelId: levelJunior.id,
      });

      const auditDemote = await prisma.auditEntry.findFirst({
        where: { action: 'ACCESS_LEVEL_CHANGED' },
      });
      expect(auditDemote?.details).toMatchObject({
        fromLevelId: levelJunior.id,
        toLevelId: levelIntern.id,
      });
    });
  });


  describe('Access Renewal (extension) flows', () => {
    let group: any;
    let level: any;
    let userAccess: any;

    beforeEach(async () => {
      group = await prisma.group.create({
        data: {
          name: 'Renewable Group',
          slug: 'renewable',
          description: 'Renewable Access',
          platform: 'redash',
          externalGroupId: 'ext-grp-renew-base',
        },
      });

      level = await prisma.groupLevel.create({
        data: {
          groupId: group.id,
          name: 'Member',
          slug: 'member',
          rank: 0,
          externalGroupId: 'ext-grp-renew-member',
        },
      });

      await prisma.userCreationRequest.create({
        data: {
          userId: testUser.id,
          userName: testUser.username,
          userEmail: testUser.email,
          platform: 'redash',
          status: UserCreationStatus.COMPLETED,
        },
      });

      const req = await accessWorkflowService.createRequest(
        testUser,
        group.id,
        'Initial grant',
        AccessDuration.ONE_MONTH,
        level.id,
      );
      await accessWorkflowService.reviewRequest(req.id, adminUser, 'APPROVED');

      userAccess = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });
    });

    it('extends the grant on the same level when an admin approves the renewal (no deprovision)', async () => {
      // Current grant is about to expire tomorrow.
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await prisma.userAccess.update({
        where: { id: userAccess.id },
        data: { expiresAt: tomorrow },
      });

      // User requests a renewal for a fresh 3-month window (keeps their current level).
      const renewal = await accessWorkflowService.requestRenewal(
        testUser,
        group.id,
        'Campaign extended into next quarter',
        AccessDuration.THREE_MONTHS,
      );
      expect(renewal.status).toBe(RequestStatus.PENDING);
      expect(renewal.levelId).toBe(level.id);

      // Until approval, the original grant stays active with its original expiry.
      const stillOld = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });
      expect(stillOld?.id).toBe(userAccess.id);
      expect(stillOld?.expiresAt?.getTime()).toBe(tomorrow.getTime());

      // Admin approves → grant extended.
      await accessWorkflowService.reviewRequest(renewal.id, adminUser, 'APPROVED');

      // Old grant deactivated; a fresh grant on the SAME level with a later expiry.
      const oldGrant = await prisma.userAccess.findUnique({ where: { id: userAccess.id } });
      expect(oldGrant?.isActive).toBe(false);

      const newGrant = await prisma.userAccess.findFirst({
        where: { userId: testUser.id, groupId: group.id, isActive: true },
      });
      expect(newGrant).not.toBeNull();
      expect(newGrant?.id).not.toBe(userAccess.id);
      expect(newGrant?.levelId).toBe(level.id);
      expect(newGrant?.expiresAt!.getTime()).toBeGreaterThan(tomorrow.getTime());

      // Same external group on both sides → the user is never removed from the platform.
      expect(mockRedashAdapter.deprovision).not.toHaveBeenCalled();

      // Audited as a renewal, not a level change; old request marked superseded.
      const renewAudit = await prisma.auditEntry.findFirst({ where: { action: 'ACCESS_RENEWED' } });
      expect(renewAudit).not.toBeNull();
      const oldRequest = await prisma.accessRequest.findUnique({
        where: { id: userAccess.accessRequestId },
      });
      expect(oldRequest?.status).toBe(RequestStatus.REVOKED);
      expect(oldRequest?.revokeReason).toContain('renewal');
    });

    it('rejects a renewal when the user has no active access to the group', async () => {
      await accessWorkflowService.revokeAccess(userAccess.id, adminUser, 'cleanup');
      await expect(
        accessWorkflowService.requestRenewal(
          testUser,
          group.id,
          'please extend my access',
          AccessDuration.ONE_MONTH,
        ),
      ).rejects.toThrow(ConflictError);
    });

    it('rejects a renewal when an open request already exists for the group', async () => {
      await accessWorkflowService.requestRenewal(
        testUser,
        group.id,
        'first renewal attempt',
        AccessDuration.ONE_MONTH,
      );
      await expect(
        accessWorkflowService.requestRenewal(
          testUser,
          group.id,
          'second renewal attempt',
          AccessDuration.ONE_MONTH,
        ),
      ).rejects.toThrow(ConflictError);
    });
  });
});
