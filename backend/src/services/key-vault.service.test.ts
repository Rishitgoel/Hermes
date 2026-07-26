// Enable the Azure instance in simulation so config.secretsInstances registers it. Must be set
// before config is imported. No vault pin — the instance runs in DISCOVERY mode, which is the
// default shape both live and simulated.
process.env.SECRETS_AZURE_SIMULATION = 'true';
delete process.env.SECRETS_AZURE_VAULT_NAME;

import { describe, it, expect, beforeEach } from 'vitest';
import { KeyVaultService } from './key-vault.service';
import { getSecretsManagerService } from './secrets-manager.service';
import {
  deriveEnvVar,
  SecretsInstanceConfig,
} from './secret-store.interface';
import { NotFoundError, ValidationError } from '../utils/errors';

/** The primary seeded simulation vault (see KeyVaultService.ensureSimSeeded). */
const VAULT = 'bachatt-sim-kv';
/** A second seeded vault — present so the multi-vault behaviour is actually exercised. */
const VAULT_2 = 'bachatt-sim-kv-analytics';

const INSTANCE: SecretsInstanceConfig = {
  key: 'secrets-azure',
  provider: 'azure',
  region: undefined,
  endpoint: undefined,
  isSimulation: true,
  accessKeyId: undefined,
  secretAccessKey: undefined,
  profile: undefined,
  // Discovery mode: no pin, so listAllSecrets() enumerates vaults the way the AWS store
  // enumerates an account's secrets.
  vaultName: undefined,
  subscriptionId: undefined,
  tenantId: undefined,
  clientId: undefined,
  clientSecret: undefined,
};

/**
 * The Key Vault store presents a FLAT vault through the same two-level SecretStore contract the
 * AWS store implements: the vault is the "secret", its secrets are the "keys". These are the
 * conformance expectations that keep every caller above the store provider-agnostic.
 */
describe('KeyVaultService (simulation)', () => {
  let svc: KeyVaultService;

  beforeEach(() => {
    svc = new KeyVaultService(INSTANCE);
  });

  describe('the vault is the secret', () => {
    it('lists every visible vault as a "secret"', async () => {
      expect(await svc.listAllSecrets()).toEqual([VAULT, VAULT_2]);
      // The deprecated AWS-flavoured alias must stay in lockstep.
      expect(await svc.listAllAwsSecrets()).toEqual([VAULT, VAULT_2]);
    });

    it('enumerates the vault contents as that secret\'s keys', async () => {
      const res = await svc.listSecretKeys(VAULT);
      expect(res.exists).toBe(true);
      expect(res.keys).toContain('orbit-kfin-username');
      expect(res.keys).toContain('saathi-database-url');
      // Sorted, like the AWS store's list.
      expect(res.keys).toEqual([...res.keys].sort());
    });

    it('reports any other name as non-existent rather than reading the wrong place', async () => {
      expect(await svc.listSecretKeys('some-other-vault')).toEqual({
        exists: false,
        keys: [],
      });
      expect(await svc.getSecretMap('some-other-vault')).toBeNull();
    });

    it('matches the vault name case-insensitively (Azure vault names are)', async () => {
      expect((await svc.listSecretKeys(VAULT.toUpperCase())).exists).toBe(true);
    });

    it('keeps each vault\'s keys and writes separate', async () => {
      // The whole point of discovery mode: several vaults behind one instance, each its own
      // "secret". A key written to one must never appear in another.
      const one = await svc.listSecretKeys(VAULT);
      const two = await svc.listSecretKeys(VAULT_2);
      expect(one.keys).toContain('orbit-kfin-username');
      expect(two.keys).toContain('metabase-db-password');
      expect(two.keys).not.toContain('orbit-kfin-username');

      await svc.putSecretKeyValues(
        VAULT_2,
        { 'metabase-new-key': 'v' },
        { createIfMissing: true },
      );
      expect((await svc.listSecretKeys(VAULT_2)).keys).toContain('metabase-new-key');
      expect((await svc.listSecretKeys(VAULT)).keys).not.toContain('metabase-new-key');
    });

    it('refuses to write to a vault it cannot see, even with createIfMissing', async () => {
      // Hermes creates SECRETS in an existing vault, never a vault.
      await expect(
        svc.putSecretKeyValues('no-such-vault', { k: 'v' }, { createIfMissing: true }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('getSecretMap', () => {
    it('returns every value when no keys are given', async () => {
      const map = await svc.getSecretMap(VAULT);
      expect(map).not.toBeNull();
      expect(map!['orbit-kfin-username']).toBe('orbit_kfin_user');
    });

    it('narrows to just the requested keys (one GetSecret per key on Azure)', async () => {
      const map = await svc.getSecretMap(VAULT, ['orbit-kfin-password']);
      expect(map).toEqual({ 'orbit-kfin-password': 'orbit_kfin_pass' });
    });

    it('omits a key that does not exist — an ADD, not an error', async () => {
      const map = await svc.getSecretMap(VAULT, ['orbit-kfin-password', 'not-there']);
      expect(map).toEqual({ 'orbit-kfin-password': 'orbit_kfin_pass' });
      expect(map).not.toHaveProperty('not-there');
    });
  });

  describe('putSecretKeyValues', () => {
    it('merges new keys in and leaves the rest alone', async () => {
      await svc.putSecretKeyValues(
        VAULT,
        { 'orbit-brand-new': 'v1' },
        { createIfMissing: true },
      );
      const map = await svc.getSecretMap(VAULT);
      expect(map!['orbit-brand-new']).toBe('v1');
      expect(map!['orbit-kfin-username']).toBe('orbit_kfin_user');
    });

    it('overwrites an existing key\'s value', async () => {
      await svc.putSecretKeyValues(
        VAULT,
        { 'orbit-kfin-password': 'rotated' },
        { createIfMissing: false },
      );
      expect(await svc.getSecretMap(VAULT, ['orbit-kfin-password'])).toEqual({
        'orbit-kfin-password': 'rotated',
      });
    });

    it('surfaces a written key in the key list (cache invalidated)', async () => {
      await svc.putSecretKeyValues(VAULT, { 'orbit-fresh': 'v' }, { createIfMissing: true });
      expect((await svc.listSecretKeys(VAULT)).keys).toContain('orbit-fresh');
    });

    it('rejects a name Key Vault would reject, with a Hermes error not an opaque 400', async () => {
      await expect(
        svc.putSecretKeyValues(VAULT, { 'has_underscore': 'v' }, { createIfMissing: true }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        svc.putSecretKeyValues(VAULT, { 'has.dot': 'v' }, { createIfMissing: true }),
      ).rejects.toBeInstanceOf(ValidationError);
      // ...and writes nothing when any name in the batch is invalid.
      expect((await svc.listSecretKeys(VAULT)).keys).not.toContain('has.dot');
    });

    it('refuses to write to a vault that is not this instance\'s', async () => {
      // Hermes can create a SECRET in a vault, never a vault — so createIfMissing cannot help.
      await expect(
        svc.putSecretKeyValues('other-kv', { k: 'v' }, { createIfMissing: true }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        svc.putSecretKeyValues('other-kv', { k: 'v' }, { createIfMissing: false }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('__resetSim empties the vault (test isolation)', async () => {
    svc.__resetSim();
    expect((await svc.listSecretKeys(VAULT)).keys).toEqual([]);
  });

  it('reports healthy in simulation', async () => {
    expect(await svc.healthCheck()).toEqual({ healthy: true, message: 'simulation' });
  });

  it('shares scope-pattern parsing with the AWS store', () => {
    expect(svc.parseScopePatterns(VAULT)).toEqual([
      { kind: 'exact', name: VAULT, raw: VAULT },
    ]);
    expect(svc.matchesPattern({ kind: 'all', raw: '*' }, VAULT)).toBe(true);
    expect(
      svc.matchesPattern({ kind: 'exact', name: VAULT, raw: VAULT }, VAULT.toUpperCase()),
    ).toBe(true);
  });
});

describe('getSecretsManagerService routing', () => {
  it('resolves the Azure instance to a KeyVaultService', () => {
    expect(getSecretsManagerService('secrets-azure')).toBeInstanceOf(KeyVaultService);
  });

  it('leaves the AWS instances on the Secrets Manager store', () => {
    expect(getSecretsManagerService('secrets')).not.toBeInstanceOf(KeyVaultService);
  });
});

/**
 * The env-var convention, verified against every entry in azure/orbit and azure/saathi-be on
 * infra-deployment origin/main: drop the leading `<service>-` segment, uppercase, dashes → _.
 */
describe('deriveEnvVar', () => {
  it.each([
    ['orbit-kfin-username', 'KFIN_USERNAME'],
    ['orbit-azure-openai-api-key', 'AZURE_OPENAI_API_KEY'],
    ['orbit-bse-password-api', 'BSE_PASSWORD_API'],
    ['saathi-app-jwt-algorithm', 'APP_JWT_ALGORITHM'],
    ['saathi-azure-storage-key', 'AZURE_STORAGE_KEY'],
    ['saathi-database-url', 'DATABASE_URL'],
  ])('%s → %s', (input, expected) => {
    expect(deriveEnvVar(input)).toBe(expected);
  });

  it('keeps a single-segment name whole rather than emptying it', () => {
    expect(deriveEnvVar('databaseurl')).toBe('DATABASEURL');
  });

  it('is blank-safe', () => {
    expect(deriveEnvVar('')).toBe('');
    expect(deriveEnvVar('   ')).toBe('');
  });

  // azure/tolgee maps tolgee-db-password → SPRING_DATASOURCE_PASSWORD, which no rule can predict.
  // This is exactly why the derived value is only ever a prefill the requester can override.
  it('cannot predict azure/tolgee\'s legacy mappings — hence the override', () => {
    expect(deriveEnvVar('tolgee-db-password')).toBe('DB_PASSWORD');
    expect(deriveEnvVar('tolgee-db-password')).not.toBe('SPRING_DATASOURCE_PASSWORD');
  });
});
