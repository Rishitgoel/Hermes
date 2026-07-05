process.env.SECRETS_INGESTION_SIMULATION = 'true';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../config/prisma';
import { secretIngestionService } from './secret-ingestion.service';
import { secretsManagerService } from './secrets-manager.service';
import { secretsProvisioner } from './secrets.provisioner';
import { AuthorizationError, ConflictError } from '../utils/errors';

describe('SecretIngestionService (simulation)', () => {
  const USER = { id: 'usr-secrets-1', username: 'Bob', email: 'bob@bachatt.app' };
  const REVIEWER = { id: 'admin-secrets-1', username: 'Boss' };
  const SECRET_NAMES = ['payment/gateway', 'payment/webhook'];
  const EXTERNAL_GROUP_ID = SECRET_NAMES.join('\n');

  beforeEach(() => {
    secretsManagerService.__resetSim();
  });

  async function mintUser(): Promise<string> {
    const { externalUserId } = await secretsProvisioner.inviteUser(USER.email, USER.username, USER.id);
    await prisma.userCreationRequest.create({
      data: {
        userId: USER.id,
        userName: USER.username,
        userEmail: USER.email,
        platform: 'secrets',
        status: 'COMPLETED',
        externalUserId,
      },
    });
    return externalUserId;
  }

  async function setupGrant(opts: { slug?: string; name?: string; externalGroupId?: string } = {}) {
    const externalUserId = await mintUser();
    const group = await prisma.group.create({
      data: {
        name: opts.name ?? 'Payment Secrets',
        slug: opts.slug ?? 'secrets-test-group',
        description: '',
        platform: 'secrets',
        externalGroupId: opts.externalGroupId ?? EXTERNAL_GROUP_ID,
        tables: [],
      },
    });
    await prisma.userAccess.create({
      data: {
        userId: USER.id,
        userName: USER.username,
        userEmail: USER.email,
        groupId: group.id,
        isActive: true,
        externalUserId,
        grantedBy: 'test',
      },
    });
    return { group, externalUserId };
  }

  it('getUserScope returns the granted secrets', async () => {
    const { group } = await setupGrant();
    const scope = await secretIngestionService.getUserScope(USER.id);
    expect(scope).toHaveLength(1);
    expect(scope[0]).toMatchObject({
      groupId: group.id,
      groupName: 'Payment Secrets',
      secretNames: SECRET_NAMES,
    });
  });

  it('listSecretKeys retrieves masked key names for in-scope secrets', async () => {
    await setupGrant();
    await secretsManagerService.putSecretKeyValues('payment/gateway', { 'api-key': 'super-secret' }, { createIfMissing: true });

    const result = await secretIngestionService.listSecretKeys(USER.id, 'payment/gateway');
    expect(result.exists).toBe(true);
    expect(result.keys).toEqual(['api-key']);
  });

  it('listSecretKeys throws AuthorizationError for out-of-scope secrets', async () => {
    await setupGrant();
    await expect(
      secretIngestionService.listSecretKeys(USER.id, 'other/secret')
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('createIngestionRequest stages a PENDING request and triggers events', async () => {
    const { group } = await setupGrant();
    const request = await secretIngestionService.createIngestionRequest({
      requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
      secretName: 'payment/gateway',
      entries: [
        { key: 'API_KEY', value: 'secret-val-1' },
        { key: 'API_URL', value: 'http://test' },
      ],
      justification: 'Ingest Stripe keys',
    });

    expect(request.status).toBe('PENDING');
    expect(request.groupId).toBe(group.id);
    expect(request.secretName).toBe('payment/gateway');
    expect(request.entries).toHaveLength(2);

    const dbRow = await prisma.secretIngestionRequest.findUnique({ where: { id: request.id } });
    expect(dbRow).not.toBeNull();
  });

  it('createIngestionRequest throws AuthorizationError for out-of-scope secrets', async () => {
    await setupGrant();
    await expect(
      secretIngestionService.createIngestionRequest({
        requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
        secretName: 'other/secret',
        entries: [{ key: 'KEY', value: 'val' }],
      })
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('createIngestionRequest canonicalizes the secret name casing from the grant, not client input', async () => {
    await setupGrant();
    // Grant lists 'payment/gateway' (lowercase); client sends a differently-cased variant.
    // AWS secret names are case-sensitive, so the stored/applied name must be the grant's
    // exact casing — otherwise this would create a sibling secret instead of matching it.
    const request = await secretIngestionService.createIngestionRequest({
      requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
      secretName: 'PAYMENT/GATEWAY',
      entries: [{ key: 'API_KEY', value: 'secret-val-1' }],
    });
    expect(request.secretName).toBe('payment/gateway');
  });

  it('listSecretKeys resolves a differently-cased in-scope secret name to the canonical casing', async () => {
    await setupGrant();
    await secretsManagerService.putSecretKeyValues('payment/gateway', { 'api-key': 'x' }, { createIfMissing: true });
    const result = await secretIngestionService.listSecretKeys(USER.id, 'PAYMENT/GATEWAY');
    expect(result.exists).toBe(true);
    expect(result.keys).toEqual(['api-key']);
  });

  it('reviewIngestionRequest merges approved keys and redacts values post-terminal', async () => {
    const { group } = await setupGrant();
    const request = await secretIngestionService.createIngestionRequest({
      requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
      secretName: 'payment/gateway',
      entries: [
        { key: 'API_KEY', value: 'secret-val-1' },
        { key: 'API_URL', value: 'http://test' },
      ],
      justification: 'Ingest Stripe keys',
    });

    const reviewed = await secretIngestionService.reviewIngestionRequest(
      request.id,
      { id: REVIEWER.id, username: REVIEWER.username },
      [
        { key: 'API_KEY', decision: 'APPROVED' },
        { key: 'API_URL', decision: 'REJECTED' },
      ],
      'Approved key but url is rejected'
    );

    expect(reviewed.status).toBe('PARTIALLY_APPLIED');
    expect(reviewed.reviewerName).toBe(REVIEWER.username);
    expect(reviewed.reviewNote).toBe('Approved key but url is rejected');

    // Values should be redacted in database row post-terminal
    const entries = reviewed.entries as any[];
    expect(entries[0].value).toBeNull();
    expect(entries[0].decision).toBe('APPROVED');
    expect(entries[0].applied).toBe(true);

    expect(entries[1].value).toBeNull();
    expect(entries[1].decision).toBe('REJECTED');
    expect(entries[1].applied).toBe(false);

    // Verify secret was created/merged in simulation
    const liveKeys = await secretsManagerService.listSecretKeys('payment/gateway');
    expect(liveKeys.exists).toBe(true);
    expect(liveKeys.keys).toEqual(['API_KEY']);

    const valueMap = await secretsManagerService.getSecretMap('payment/gateway');
    expect(valueMap?.['API_KEY']).toBe('secret-val-1');
    expect(valueMap?.['API_URL']).toBeUndefined();
  });

  it('reviewIngestionRequest keeps values on APPLY_FAILED (retryable) and only redacts once a retry lands on a terminal status', async () => {
    await setupGrant();
    const request = await secretIngestionService.createIngestionRequest({
      requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
      secretName: 'payment/gateway',
      entries: [{ key: 'API_KEY', value: 'secret-val-1' }],
    });

    const spy = vi
      .spyOn(secretsManagerService, 'putSecretKeyValues')
      .mockRejectedValueOnce(new Error('throttled'));

    const firstAttempt = await secretIngestionService.reviewIngestionRequest(
      request.id,
      { id: REVIEWER.id, username: REVIEWER.username },
      [{ key: 'API_KEY', decision: 'APPROVED' }],
    );
    expect(firstAttempt.status).toBe('APPLY_FAILED');
    const entriesAfterFailure = firstAttempt.entries as any[];
    expect(entriesAfterFailure[0].value).toBe('secret-val-1'); // not redacted — still retryable

    spy.mockRestore();

    // Retry from APPLY_FAILED must be allowed (not rejected as "not pending").
    const secondAttempt = await secretIngestionService.reviewIngestionRequest(
      request.id,
      { id: REVIEWER.id, username: REVIEWER.username },
      [{ key: 'API_KEY', decision: 'APPROVED' }],
    );
    expect(secondAttempt.status).toBe('APPLIED');
    const entriesAfterSuccess = secondAttempt.entries as any[];
    expect(entriesAfterSuccess[0].value).toBeNull(); // now genuinely terminal — redacted

    const valueMap = await secretsManagerService.getSecretMap('payment/gateway');
    expect(valueMap?.['API_KEY']).toBe('secret-val-1');
  });

  // ── Live wildcard / prefix scope ────────────────────────────────────────────────
  // In simulation, listAllAwsSecrets() returns a fixed set once the seeded payment/* secrets
  // are cleared by __resetSim: analytics/mixpanel, common/api-keys, prod/database, prod/redis,
  // staging/database, staging/redis.

  it("getUserScope expands a '*' wildcard to every AWS secret (live)", async () => {
    const { group } = await setupGrant({ externalGroupId: '*' });
    const scope = await secretIngestionService.getUserScope(USER.id);
    expect(scope).toHaveLength(1);
    expect(scope[0].groupId).toBe(group.id);
    expect(scope[0].secretNames).toEqual(
      expect.arrayContaining(['prod/database', 'prod/redis', 'staging/database', 'analytics/mixpanel']),
    );
    // A newly-created secret shows up on the next retrieval, no group edit needed.
    await secretsManagerService.putSecretKeyValues('brand/new-secret', { K: 'v' }, { createIfMissing: true });
    const scopeAfter = await secretIngestionService.getUserScope(USER.id);
    expect(scopeAfter[0].secretNames).toContain('brand/new-secret');
  });

  it('getUserScope expands a prefix pattern to only the matching secrets', async () => {
    await setupGrant({ externalGroupId: 'prod*' });
    const scope = await secretIngestionService.getUserScope(USER.id);
    expect(scope[0].secretNames.sort()).toEqual(['prod/database', 'prod/redis']);
  });

  it('listSecretKeys authorizes any in-scope secret under a wildcard grant', async () => {
    await setupGrant({ externalGroupId: '*' });
    await secretsManagerService.putSecretKeyValues('prod/database', { PASSWORD: 'x' }, { createIfMissing: true });
    const result = await secretIngestionService.listSecretKeys(USER.id, 'prod/database');
    expect(result.exists).toBe(true);
    expect(result.keys).toEqual(['PASSWORD']);
  });

  it('createIngestionRequest allows staging a brand-new secret inside a prefix namespace', async () => {
    const { group } = await setupGrant({ externalGroupId: 'investments*' });
    const request = await secretIngestionService.createIngestionRequest({
      requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
      secretName: 'investments/new-fund',
      entries: [{ key: 'API_KEY', value: 'v' }],
    });
    expect(request.status).toBe('PENDING');
    expect(request.groupId).toBe(group.id);
    expect(request.secretName).toBe('investments/new-fund');
  });

  it('createIngestionRequest still rejects a secret outside a prefix namespace', async () => {
    await setupGrant({ externalGroupId: 'investments*' });
    await expect(
      secretIngestionService.createIngestionRequest({
        requester: { id: USER.id, username: USER.username, email: USER.email, roles: [] },
        secretName: 'payments/gateway',
        entries: [{ key: 'K', value: 'v' }],
      })
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('sweepStuckApplying recovers APPLYING requests', async () => {
    const { group } = await setupGrant();
    const request = await prisma.secretIngestionRequest.create({
      data: {
        requesterId: USER.id,
        requesterName: USER.username,
        requesterEmail: USER.email,
        groupId: group.id,
        secretName: 'payment/gateway',
        entries: [{ key: 'KEY', value: 'val' }],
        status: 'APPLYING',
        updatedAt: new Date(Date.now() - 3600000), // 1 hour ago
      },
    });

    await secretIngestionService.sweepStuckApplying(1800000); // 30 mins limit

    const updated = await prisma.secretIngestionRequest.findUnique({ where: { id: request.id } });
    expect(updated?.applyError).toContain('recovered by sweep');
  });
});
