import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: mockGet,
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      interceptors: { response: { use: vi.fn() } },
    }),
  },
}));

import {
  InfraRepoSyncService,
  editAzureValuesMappings,
  editValuesItems,
  referencedEnumeratedSecrets,
  registeredKeysInFile,
} from './infra-repo-sync.service';

/**
 * Azure Key Vault manifests (`azure-values`).
 *
 * Fixtures mirror the real files on infra-deployment origin/main. The two differ deliberately:
 * azure/saathi-be's mappings are alphabetically sorted, azure/orbit's are not — the editor must
 * respect whichever ordering it finds, because `deploy/seed-keyvault.sh --print-mappings` in each
 * app repo regenerates this same block and a mismatched order would churn the diff.
 */

const ORBIT_AZURE = `# Orbit (RTA report scheduler) - prod values for the shared Azure Helm chart.
fullnameOverride: orbit-prod
namespace: prod

container:
  port: 8000

# Secrets & config come from Azure Key Vault (bachatt-prod-kv).
secretsStore:
  enabled: true
  keyvaultName: bachatt-prod-kv
  tenantId: "69ea1ea9-180b-4261-811d-4a786c725d26"
  secretProviderClassName: orbit-secrets-provider
  secretName: orbit-secrets-prod
  mappings:
    - objectName: orbit-kfin-username
      key: KFIN_USERNAME
    - objectName: orbit-kfin-password
      key: KFIN_PASSWORD
    - objectName: orbit-azure-openai-endpoint
      key: AZURE_OPENAI_ENDPOINT

resources:
  requests:
    cpu: 200m
`;

const SAATHI_AZURE = `secretsStore:
  enabled: true
  keyvaultName: bachatt-prod-kv
  secretName: saathi-be-secrets-prod
  mappings:
    - objectName: saathi-app-jwt-algorithm
      key: APP_JWT_ALGORITHM
    - objectName: saathi-app-jwt-secret
      key: APP_JWT_SECRET
    - objectName: saathi-database-url
      key: DATABASE_URL
`;

/** An AWS-shaped manifest, for the cross-contamination checks. */
const AWS_VALUES = `secretsStore:
  enabled: true
  provider: aws
  mappings:
    - awsSecretName: Investment-Middleware-Secrets-Prod
      items:
        - EXISTING_KEY
`;

const ORBIT_PATH = 'azure/orbit/prod/values-prod-azure.yaml';
const AWS_PATH = 'auth-service/prod/values-prod.yaml';
const VAULT = 'bachatt-prod-kv';

describe('azure-values — scanning', () => {
  it('indexes an azure manifest under its VAULT name, with mech azure-values', () => {
    expect(referencedEnumeratedSecrets(ORBIT_PATH, ORBIT_AZURE)).toEqual([
      { path: ORBIT_PATH, mech: 'azure-values' },
    ]);
  });

  it('reports the registered objectNames for drift', () => {
    expect(registeredKeysInFile(ORBIT_PATH, ORBIT_AZURE, VAULT)).toEqual({
      referenced: true,
      unmatched: false,
      keys: [
        'orbit-kfin-username',
        'orbit-kfin-password',
        'orbit-azure-openai-endpoint',
      ],
    });
  });

  it('is not referenced by a manifest pointing at a different vault', () => {
    const other = ORBIT_AZURE.replace(
      `keyvaultName: ${VAULT}`,
      'keyvaultName: bachatt-qa-kv',
    );
    expect(registeredKeysInFile(ORBIT_PATH, other, VAULT).referenced).toBe(false);
    expect(editAzureValuesMappings(other, VAULT, ['x'])).toEqual({
      status: 'not-referenced',
    });
  });

  it('reports unmatched (NOT "no keys") when the vault is referenced but has no mappings list', () => {
    const noMappings = `secretsStore:\n  enabled: true\n  keyvaultName: ${VAULT}\n  secretName: x-prod\n`;
    expect(registeredKeysInFile(ORBIT_PATH, noMappings, VAULT)).toEqual({
      referenced: true,
      keys: [],
      unmatched: true,
    });
    // toMatchObject, not toEqual — `unmatched` also carries a diagnostic `reason`.
    expect(editAzureValuesMappings(noMappings, VAULT, ['x'])).toMatchObject({
      status: 'unmatched',
    });
  });

  it('never confuses an AWS manifest for an azure one, or the reverse', () => {
    // The AWS scanner keys off `awsSecretName:`, which an azure manifest never has.
    expect(referencedEnumeratedSecrets(AWS_PATH, ORBIT_AZURE)).toEqual([]);
    // ...and the AWS editor finds nothing to do in azure content, so a misroute is a no-op
    // rather than a wrong edit.
    expect(editValuesItems(ORBIT_AZURE, VAULT, ['x'])).toEqual({
      status: 'not-referenced',
    });
  });
});

describe('azure-values — editing', () => {
  it('appends an objectName/key pair, deriving the env var from the secret name', () => {
    const res = editAzureValuesMappings(ORBIT_AZURE, VAULT, ['orbit-report-email']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') {
      return;
    }
    expect(res.added).toEqual(['orbit-report-email']);
    expect(res.content).toContain(
      '    - objectName: orbit-report-email\n      key: REPORT_EMAIL',
    );
    // Existing entries and surrounding content survive untouched.
    expect(res.content).toContain('      key: KFIN_USERNAME');
    expect(res.content).toContain(
      '# Secrets & config come from Azure Key Vault (bachatt-prod-kv).',
    );
    expect(res.content).toContain('  requests:\n    cpu: 200m');
  });

  it('honours an explicit env-var override (azure/tolgee-style non-derivable mapping)', () => {
    const res = editAzureValuesMappings(ORBIT_AZURE, VAULT, ['orbit-db-password'], {
      'orbit-db-password': 'SPRING_DATASOURCE_PASSWORD',
    });
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') {
      return;
    }
    expect(res.content).toContain('      key: SPRING_DATASOURCE_PASSWORD');
    expect(res.content).not.toContain('key: DB_PASSWORD');
  });

  it('is idempotent — an already-registered key reports up-to-date', () => {
    expect(
      editAzureValuesMappings(ORBIT_AZURE, VAULT, ['orbit-kfin-password']),
    ).toEqual({ status: 'up-to-date' });
  });

  it('only adds the keys that are actually missing', () => {
    const res = editAzureValuesMappings(ORBIT_AZURE, VAULT, [
      'orbit-kfin-username',
      'orbit-new-key',
    ]);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') {
      return;
    }
    expect(res.added).toEqual(['orbit-new-key']);
    // The already-present key must not be duplicated.
    expect(res.content.match(/objectName: orbit-kfin-username/g)).toHaveLength(1);
  });

  it('inserts in sorted position when the existing list is sorted (saathi-be)', () => {
    const res = editAzureValuesMappings(SAATHI_AZURE, VAULT, [
      'saathi-cors-allow-origins',
    ]);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') {
      return;
    }
    const order = [...res.content.matchAll(/objectName: (\S+)/g)].map((m) => m[1]);
    expect(order).toEqual([
      'saathi-app-jwt-algorithm',
      'saathi-app-jwt-secret',
      'saathi-cors-allow-origins',
      'saathi-database-url',
    ]);
  });

  it('appends at the end when the existing list is NOT sorted (orbit)', () => {
    const res = editAzureValuesMappings(ORBIT_AZURE, VAULT, ['orbit-aaa-first']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') {
      return;
    }
    const order = [...res.content.matchAll(/objectName: (\S+)/g)].map((m) => m[1]);
    // Appended last rather than re-sorted — the file's own ordering is left alone.
    expect(order[order.length - 1]).toBe('orbit-aaa-first');
  });

  it('preserves CRLF line endings', () => {
    const crlf = ORBIT_AZURE.replace(/\n/g, '\r\n');
    const res = editAzureValuesMappings(crlf, VAULT, ['orbit-report-email']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') {
      return;
    }
    expect(res.content).toContain('\r\n');
    expect(res.content).not.toMatch(/[^\r]\n/);
  });

  it('reads a key-first entry as an existing mapping, not a missing one', () => {
    // `- key:` before `objectName:` is the same YAML mapping. Parsing only the dash line's first
    // field would treat it as absent → a duplicate entry here, and every vault key reported as
    // drift there.
    const keyFirst = `secretsStore:
  keyvaultName: ${VAULT}
  mappings:
    - key: KFIN_USERNAME
      objectName: orbit-kfin-username
`;
    expect(registeredKeysInFile(ORBIT_PATH, keyFirst, VAULT)).toEqual({
      referenced: true,
      unmatched: false,
      keys: ['orbit-kfin-username'],
    });
    expect(
      editAzureValuesMappings(keyFirst, VAULT, ['orbit-kfin-username']),
    ).toEqual({ status: 'up-to-date' });
  });

  it('rewrites an existing entry in place when the env var is overridden', () => {
    // Skipping this silently accepted, badged and audited a rename that never reached the manifest.
    const res = editAzureValuesMappings(ORBIT_AZURE, VAULT, ['orbit-kfin-username'], {
      'orbit-kfin-username': 'KFIN_USER',
    });
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') {
      return;
    }
    expect(res.content).toContain('      key: KFIN_USER');
    expect(res.content).not.toContain('key: KFIN_USERNAME');
    // Reported as a change to this file so the preview/PR body see it...
    expect(res.added).toEqual(['orbit-kfin-username']);
    // ...and re-running is a no-op.
    const again = editAzureValuesMappings(res.content, VAULT, ['orbit-kfin-username'], {
      'orbit-kfin-username': 'KFIN_USER',
    });
    expect(again).toEqual({ status: 'up-to-date' });
    // No duplicate entry was appended.
    expect(res.content.match(/objectName: orbit-kfin-username/g)).toHaveLength(1);
  });

  it('refuses to create two mappings for the same env var', () => {
    // The shared chart renders secretObjects.data from mappings, so a duplicate `key:` collapses
    // into one Secret entry and one credential silently wins.
    const res = editAzureValuesMappings(ORBIT_AZURE, VAULT, ['tolgee-kfin-username']);
    expect(res).toMatchObject({ status: 'unmatched' });
    expect((res as { reason?: string }).reason).toContain('KFIN_USERNAME');
  });

  it('refuses to write a scalar that would restructure the YAML', () => {
    const res = editAzureValuesMappings(ORBIT_AZURE, VAULT, ['orbit-x'], {
      'orbit-x': 'FOO\n    - objectName: saathi-app-jwt-secret\n      key: JWT',
    });
    expect(res).toMatchObject({ status: 'unmatched' });
    expect((res as { reason?: string }).reason).toContain('unsafe');
  });

  it('refuses to edit a mappings list holding an entry it cannot read', () => {
    const partial = `secretsStore:
  keyvaultName: ${VAULT}
  mappings:
    - objectName: orbit-kfin-username
      key: KFIN_USERNAME
    - someOtherShape: true
`;
    // Reported as unknown-not-empty, so drift can't claim every vault key is missing here.
    expect(registeredKeysInFile(ORBIT_PATH, partial, VAULT)).toEqual({
      referenced: true,
      unmatched: true,
      keys: [],
    });
    expect(editAzureValuesMappings(partial, VAULT, ['orbit-new'])).toMatchObject({
      status: 'unmatched',
    });
  });

  it('keeps several new keys in sorted order when they land at the same slot', () => {
    const res = editAzureValuesMappings(SAATHI_AZURE, VAULT, [
      'saathi-czz-last',
      'saathi-caa-first',
    ]);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') {
      return;
    }
    const order = [...res.content.matchAll(/objectName: (\S+)/g)].map((m) => m[1]);
    expect(order).toEqual([
      'saathi-app-jwt-algorithm',
      'saathi-app-jwt-secret',
      'saathi-caa-first',
      'saathi-czz-last',
      'saathi-database-url',
    ]);
  });
});

/**
 * Path scoping. The AWS and Azure instances share ONE repo but own disjoint folders — without
 * this, each would index (and could edit) the other's manifests.
 */
describe('infra repo path scoping', () => {
  const cfg = (extra: Record<string, unknown>) =>
    ({
      token: 'test-token',
      owner: 'bachatt-app',
      repo: 'infra-deployment',
      baseBranch: 'main',
      apiBaseUrl: 'https://api.github.com',
      isSimulation: false,
      ...extra,
    }) as any;

  /** Mocks a tree holding one AWS manifest and one Azure one; returns the paths actually read. */
  function mockRepo(): string[] {
    const read: string[] = [];
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) {
        return Promise.resolve({ data: { object: { sha: 'c1' } } });
      }
      if (url.includes('/git/commits/')) {
        return Promise.resolve({ data: { tree: { sha: 't1' } } });
      }
      if (url.includes('/git/trees/')) {
        return Promise.resolve({
          data: {
            tree: [
              { path: AWS_PATH, type: 'blob' },
              { path: ORBIT_PATH, type: 'blob' },
            ],
          },
        });
      }
      if (url.includes('/contents/')) {
        const p = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
        read.push(p);
        const body = p === ORBIT_PATH ? ORBIT_AZURE : AWS_VALUES;
        return Promise.resolve({
          data: {
            sha: 'blob-sha',
            content: Buffer.from(body, 'utf8').toString('base64'),
          },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    return read;
  }

  beforeEach(() => {
    mockGet.mockReset();
    vi.stubEnv('INFRA_REPO_SIMULATION', 'false');
    vi.stubEnv('INFRA_REPO_TOKEN', 'test-token');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('pathInclude restricts the Azure instance to azure/ only', async () => {
    const read = mockRepo();
    const svc = new InfraRepoSyncService(cfg({ pathInclude: 'azure/' }));
    const targets = await svc.resolveTargets(VAULT, ['orbit-report-email']);
    expect([...new Set(read)]).toEqual([ORBIT_PATH]);
    expect(targets.map((t) => t.path)).toEqual([ORBIT_PATH]);
    expect(targets[0].format).toBe('azure-values');
  });

  it('pathExclude keeps the AWS instance out of azure/', async () => {
    const read = mockRepo();
    const svc = new InfraRepoSyncService(cfg({ pathExclude: ['azure/'] }));
    await svc.resolveTargets('Investment-Middleware-Secrets-Prod', ['NEW_KEY']);
    expect([...new Set(read)]).toEqual([AWS_PATH]);
    expect(read).not.toContain(ORBIT_PATH);
  });

  it('so the AWS instance can never resolve the Azure vault as a target', async () => {
    mockRepo();
    const aws = new InfraRepoSyncService(cfg({ pathExclude: ['azure/'] }));
    // The vault is only ever named under azure/, which this instance does not scan.
    expect(await aws.resolveTargets(VAULT, ['orbit-report-email'])).toEqual([]);
  });
});
