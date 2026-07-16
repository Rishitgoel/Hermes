import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockPatch = vi.fn();
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: mockGet,
      post: mockPost,
      put: mockPut,
      patch: mockPatch,
      interceptors: { response: { use: vi.fn() } },
    }),
  },
}));

import infraRepoSyncService, {
  InfraRepoSyncService,
  editValuesItems,
  editSpc,
  referencedEnumeratedSecrets,
  envOf,
} from './infra-repo-sync.service';
import config from '../config/config';

/**
 * Unit tests for the pure YAML editors that register a new key name in the
 * infra-deployment manifests. These are the surgical line-insertions the auto-PR
 * commits — they must preserve comments/formatting and be idempotent.
 */

const VALUES = `secretsStore:
  enabled: true
  provider: aws
  secretName: investment-service-prod-secrets
  mappings:
    - awsSecretName: Investment-Middleware-Secrets-Prod
      items:
        - bachatt_master_datasource_jdbcUrl
        - cybrilla_client_id  # kv pair for cybrilla
        - S3_iam_role
    - awsSecretName: "other-secret-prod"
      items:
        - EXISTING_KEY

hpa:
  enabled: true
`;

const SPC = `apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: auth-secrets-provider-prod
spec:
  provider: aws
  parameters:
    objects: |
      - objectName: Auth-Service-Secrets-Prod
        objectType: secretsmanager
        jmesPath:
          - path: "spring_datasource_url"
            objectAlias: spring_datasource_url
          - path: redis_host
            objectAlias: redis_host
    syncSecret: "true"
  secretObjects:
    - secretName: auth-secrets-prod
      type: Opaque
      data:
        - objectName: spring_datasource_url
          key: spring_datasource_url
        - objectName: redis_host
          key: redis_host
`;

describe('editValuesItems', () => {
  it('appends a missing key to the matching mapping items list', () => {
    const res = editValuesItems(VALUES, 'Investment-Middleware-Secrets-Prod', ['NEW_KEY']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') throw new Error('unreachable');
    expect(res.added).toEqual(['NEW_KEY']);
    expect(res.content).toContain('        - NEW_KEY');
    // inserted into the RIGHT mapping (after S3_iam_role, before the next mapping)
    const idxNew = res.content.indexOf('- NEW_KEY');
    const idxOther = res.content.indexOf('other-secret-prod');
    expect(idxNew).toBeGreaterThan(0);
    expect(idxNew).toBeLessThan(idxOther);
    // untouched content preserved (comment stays)
    expect(res.content).toContain('cybrilla_client_id  # kv pair for cybrilla');
  });

  it('is idempotent — reports up-to-date when the key already exists', () => {
    expect(editValuesItems(VALUES, 'Investment-Middleware-Secrets-Prod', ['S3_iam_role'])).toEqual({ status: 'up-to-date' });
  });

  it('only adds the keys that are missing', () => {
    const res = editValuesItems(VALUES, 'Investment-Middleware-Secrets-Prod', ['S3_iam_role', 'BRAND_NEW']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') throw new Error('unreachable');
    expect(res.added).toEqual(['BRAND_NEW']);
  });

  it('matches a quoted awsSecretName', () => {
    const res = editValuesItems(VALUES, 'other-secret-prod', ['K2']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') throw new Error('unreachable');
    expect(res.content).toContain('        - K2');
  });

  it('reports not-referenced when the secret is not in this file', () => {
    expect(editValuesItems(VALUES, 'not-in-this-file', ['X'])).toEqual({ status: 'not-referenced' });
  });

  it('reports unmatched when the mapping is found but has no items: list', () => {
    const noItems = `secretsStore:
  mappings:
    - awsSecretName: shape-mismatch-secret
      items: []
`;
    expect(editValuesItems(noItems, 'shape-mismatch-secret', ['X'])).toEqual({ status: 'unmatched' });
  });

  it('preserves CRLF line endings', () => {
    const crlf = VALUES.replace(/\n/g, '\r\n');
    const res = editValuesItems(crlf, 'Investment-Middleware-Secrets-Prod', ['NEW_KEY']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') throw new Error('unreachable');
    expect(res.content).toContain('\r\n');
    expect(res.content).not.toMatch(/[^\r]\n/);
  });
});

describe('editSpc', () => {
  it('adds the key to BOTH jmesPath and secretObjects.data', () => {
    const res = editSpc(SPC, 'Auth-Service-Secrets-Prod', ['FAST2SMS_API_KEY']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') throw new Error('unreachable');
    expect(res.added).toContain('FAST2SMS_API_KEY');
    expect(res.content).toContain('          - path: FAST2SMS_API_KEY');
    expect(res.content).toContain('            objectAlias: FAST2SMS_API_KEY');
    expect(res.content).toContain('        - objectName: FAST2SMS_API_KEY');
    expect(res.content).toContain('          key: FAST2SMS_API_KEY');
    // exactly one new path entry and one new data entry
    expect(res.content.match(/objectAlias: FAST2SMS_API_KEY/g)).toHaveLength(1);
    expect(res.content.match(/key: FAST2SMS_API_KEY/g)).toHaveLength(1);
  });

  it('is idempotent — reports up-to-date when the key is already present in both spots', () => {
    expect(editSpc(SPC, 'Auth-Service-Secrets-Prod', ['redis_host'])).toEqual({ status: 'up-to-date' });
  });

  it('reports not-referenced when the secret is not in this file', () => {
    expect(editSpc(SPC, 'some-other-secret', ['X'])).toEqual({ status: 'not-referenced' });
  });

  it('reports unmatched when the objectName is found but neither jmesPath nor secretObjects.data can be located', () => {
    const noStructure = `spec:
  parameters:
    objects: |
      - objectName: shape-mismatch-secret
        objectType: secretsmanager
`;
    expect(editSpc(noStructure, 'shape-mismatch-secret', ['X'])).toEqual({ status: 'unmatched' });
  });

  it('adds the key to the CORRECT secretObject data block when multiple secretObjects exist', () => {
    const multiSpc = `apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: auth-secrets-provider-prod
spec:
  provider: aws
  parameters:
    objects: |
      - objectName: Auth-Service-Secrets-Prod
        objectType: secretsmanager
        jmesPath:
          - path: "spring_datasource_url"
            objectAlias: spring_datasource_url
          - path: redis_host
            objectAlias: redis_host
    syncSecret: "true"
  secretObjects:
    - secretName: other-secrets-prod
      type: Opaque
      data:
        - objectName: other_key
          key: other_key
    - secretName: auth-secrets-prod
      type: Opaque
      data:
        - objectName: spring_datasource_url
          key: spring_datasource_url
        - objectName: redis_host
          key: redis_host
`;
    const res = editSpc(multiSpc, 'Auth-Service-Secrets-Prod', ['FAST2SMS_API_KEY']);
    expect(res.status).toBe('edited');
    if (res.status !== 'edited') throw new Error('unreachable');
    expect(res.added).toContain('FAST2SMS_API_KEY');
    
    // Check that FAST2SMS_API_KEY was added under auth-secrets-prod, NOT other-secrets-prod
    const lines = res.content.split('\n');
    const authSecretsIdx = lines.findIndex(l => l.includes('secretName: auth-secrets-prod'));
    const otherSecretsIdx = lines.findIndex(l => l.includes('secretName: other-secrets-prod'));
    const keyIdx = lines.findIndex(l => l.includes('objectName: FAST2SMS_API_KEY'));
    
    expect(keyIdx).toBeGreaterThan(authSecretsIdx);
    if (otherSecretsIdx < authSecretsIdx) {
      expect(keyIdx).toBeGreaterThan(authSecretsIdx);
    }
  });
});

describe('referencedEnumeratedSecrets', () => {
  it('finds awsSecretName references in a values file', () => {
    const refs = referencedEnumeratedSecrets('investment-service/prod/values-prod.yaml', VALUES);
    expect(refs).toHaveLength(2);
    expect(refs.every(r => r.mech === 'helm-values')).toBe(true);
  });

  it('finds the object in a SecretProviderClass but excludes key-alias objectNames', () => {
    const refs = referencedEnumeratedSecrets('auth-service/prod/secretproviderclass.yaml', SPC);
    // Only the real secret (which carries a jmesPath) — NOT the data[].objectName aliases.
    expect(refs).toHaveLength(1);
    expect(refs[0].mech).toBe('spc');
  });

  it('excludes a wholesale-mounted SPC object (no jmesPath)', () => {
    const wholesale = `spec:
  parameters:
    objects: |
      - objectName: bachatt-prod/bq-freshness-monitor/gcp-sa-json
        objectType: secretsmanager
`;
    expect(referencedEnumeratedSecrets('bq/prod/secretproviderclass.yaml', wholesale)).toHaveLength(0);
  });
});

describe('envOf', () => {
  it('derives env from the path segment', () => {
    expect(envOf('investment-service/prod/values-prod.yaml')).toBe('prod');
    expect(envOf('bureau-service/uat/secretproviderclass.yaml')).toBe('uat');
    expect(envOf('svc/qa2/values-qa2.yaml')).toBe('qa2');
  });
  it('falls back to the values-<env> suffix', () => {
    expect(envOf('gen-ui-service/values-prod.yaml')).toBe('prod');
  });
  it('returns root when no env is present', () => {
    expect(envOf('Helm_chart/chart/values.yaml')).toBe('root');
  });
});

describe('resolveTargets + openPrForRequest (simulation)', () => {
  // With no INFRA_REPO_TOKEN in the test env the service is in simulation mode — no
  // GitHub calls — so these exercise the compose-preview + open contract offline.
  it('resolveTargets returns a representative target carrying the requested keys', async () => {
    const targets = await infraRepoSyncService.resolveTargets('Investment-Middleware-Secrets-Prod', ['A', 'B']);
    expect(targets).toHaveLength(1);
    expect(targets[0].keysToAdd).toEqual(['A', 'B']);
    expect(targets[0].env).toBe('prod');
    expect(targets[0].manifestRef).toBe('Investment-Middleware-Secrets-Prod');
  });

  it('openPrForRequest reports OPEN with the added keys', async () => {
    const r = await infraRepoSyncService.openPrForRequest({
      requestId: 'req-1234abcd',
      secretName: 'Some-Secret-Prod',
      proposedKeys: ['K1', 'K2'],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Some-Secret-Prod', format: 'helm-values' }],
    });
    expect(r.state).toBe('OPEN');
    expect(r.keysAdded).toEqual(['K1', 'K2']);
    expect(r.prNumber).toBeGreaterThan(0);
  });

  it('resolveTargets marks already-present keys as not-to-add (update needs no PR)', async () => {
    // Only NEW is missing; EXISTING is already in the secret → not part of keysToAdd.
    const targets = await infraRepoSyncService.resolveTargets('Some-Secret', ['EXISTING', 'NEW'], ['EXISTING']);
    expect(targets[0].keysToAdd).toEqual(['NEW']);
  });

  it('resolveTargets: an update-only request yields no keys to add', async () => {
    const targets = await infraRepoSyncService.resolveTargets('Some-Secret', ['EXISTING'], ['EXISTING']);
    expect(targets[0].keysToAdd).toEqual([]);
  });

  it('openPrForRequest with an explicit empty selection opens NO PR', async () => {
    const r = await infraRepoSyncService.openPrForRequest({
      requestId: 'req-updateonly',
      secretName: 'Some-Secret-Prod',
      proposedKeys: ['EXISTING'],
      targets: [],
    });
    expect(r.state).toBe('SKIPPED');
    expect(r.prNumber).toBeUndefined();
  });

  it('openPrForRequest opens NO PR when no keys are actually new (all already present)', async () => {
    // targets is a real non-empty selection, but proposedKeys is empty (every requested
    // key was already in the secret) — must still skip, not open a no-op PR.
    const r = await infraRepoSyncService.openPrForRequest({
      requestId: 'req-noneproposed',
      secretName: 'Some-Secret-Prod',
      proposedKeys: [],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Some-Secret-Prod', format: 'helm-values' }],
    });
    expect(r.state).toBe('SKIPPED');
    expect(r.prNumber).toBeUndefined();
  });

  it('openPrForRequest honors a per-file key subset (simulation)', async () => {
    // Two keys proposed, but the requester narrowed this file's target to just one of them.
    const r = await infraRepoSyncService.openPrForRequest({
      requestId: 'req-keysubset',
      secretName: 'Some-Secret-Prod',
      proposedKeys: ['K1', 'K2'],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Some-Secret-Prod', format: 'helm-values', keys: ['K1'] }],
    });
    expect(r.state).toBe('OPEN');
    expect(r.keysAdded).toEqual(['K1']);
  });

  it('mergePrForRequest CLOSES (does not merge) when the only genuinely-new key was rejected', async () => {
    // Regression: a request with one UPDATE (approved) and one ADD (rejected) must not
    // merge the PR — the PR only exists for the ADD key, and it was rejected.
    const r = await infraRepoSyncService.mergePrForRequest({
      request: { id: 'req-partial', secretName: 'Growth', infraPrNumber: 555, infraPrNodeId: 'N', infraBranch: 'b' },
      approvedKeys: ['sad'], // the UPDATE key was approved
      newApprovedKeys: [], // but no genuinely-new key was approved
    });
    expect(r.state).toBe('CLOSED');
    expect(r.prNumber).toBe(555);
  });

  it('mergePrForRequest MERGES when a genuinely-new approved key remains', async () => {
    const r = await infraRepoSyncService.mergePrForRequest({
      request: { id: 'req-partial2', secretName: 'Growth', infraPrNumber: 556, infraPrNodeId: 'N', infraBranch: 'b' },
      approvedKeys: ['sad', 'sads'],
      newApprovedKeys: ['sads'],
    });
    expect(r.state).toBe('MERGED');
    expect(r.keysAdded).toEqual(['sads']);
  });

  it('branch name carries the FULL request id, not a truncated prefix (collision fix)', async () => {
    const longId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const r = await infraRepoSyncService.openPrForRequest({
      requestId: longId,
      secretName: 'Some-Secret-Prod',
      proposedKeys: ['K1'],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Some-Secret-Prod', format: 'helm-values' }],
    });
    // The old code truncated to requestId.slice(0, 8), which would leave the branch
    // ending right after the 8th character — asserting a full-id suffix catches that.
    expect(r.branch?.endsWith(longId)).toBe(true);
  });
});

describe('INFRA_REPO_API_URL SSRF guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts the default api.github.com', () => {
    vi.stubEnv('INFRA_REPO_API_URL', '');
    expect(config.infraRepo.apiBaseUrl).toBe('https://api.github.com');
  });

  it('accepts a *.github.com subdomain', () => {
    vi.stubEnv('INFRA_REPO_API_URL', 'https://uploads.github.com');
    expect(() => config.infraRepo.apiBaseUrl).not.toThrow();
  });

  it('accepts a *.ghe.com host (GitHub Enterprise Cloud)', () => {
    vi.stubEnv('INFRA_REPO_API_URL', 'https://bachatt.ghe.com');
    expect(() => config.infraRepo.apiBaseUrl).not.toThrow();
  });

  it('rejects a plaintext (non-https) URL', () => {
    vi.stubEnv('INFRA_REPO_API_URL', 'http://api.github.com');
    expect(() => config.infraRepo.apiBaseUrl).toThrow(/https/i);
  });

  it('rejects an internal/metadata host — the SSRF case the guard exists for', () => {
    vi.stubEnv('INFRA_REPO_API_URL', 'http://169.254.169.254/latest/meta-data/');
    expect(() => config.infraRepo.apiBaseUrl).toThrow();
  });

  it('rejects a lookalike host that merely contains "github.com"', () => {
    vi.stubEnv('INFRA_REPO_API_URL', 'https://github.com.evil.com');
    expect(() => config.infraRepo.apiBaseUrl).toThrow();
  });
});

describe('live-mode GitHub calls (axios mocked)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockPatch.mockReset();
    vi.stubEnv('INFRA_REPO_SIMULATION', 'false');
    vi.stubEnv('INFRA_REPO_TOKEN', 'test-token');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mergePrForRequest returns FAILED (does not throw) when the merge is blocked by branch protection', async () => {
    const svc = new InfraRepoSyncService();
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'base-commit-sha' } } });
      if (url.includes('/git/commits/')) return Promise.resolve({ data: { tree: { sha: 'base-tree-sha' } } });
      if (url.includes('/contents/')) {
        return Promise.resolve({ data: { sha: 'base-sha', content: Buffer.from(VALUES, 'utf8').toString('base64') } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPut.mockImplementation((url: string) => {
      if (url.includes('/pulls/') && url.includes('/merge')) {
        const err: any = new Error('blocked');
        err.response = { status: 405 };
        return Promise.reject(err);
      }
      return Promise.resolve({ data: {} }); // putContent
    });
    mockPost.mockResolvedValue({ data: {} }); // markReady (/graphql) + comment
    mockPatch.mockResolvedValue({ data: {} }); // resetBranchToSha

    const result = await svc.mergePrForRequest({
      request: {
        id: 'req-1',
        secretName: 'Investment-Middleware-Secrets-Prod',
        infraPrNumber: 42,
        infraPrNodeId: 'PR_node',
        infraBranch: 'hermes/secret-keys/investment-middleware-secrets-prod-req-1',
      },
      approvedKeys: ['NEW_KEY'],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Investment-Middleware-Secrets-Prod', format: 'helm-values' }],
    });

    // The core regression: this must resolve, not reject — otherwise the caller's
    // persistInfraResult() call is skipped and the request row is left stale.
    expect(result.state).toBe('FAILED');
    expect(result.prNumber).toBe(42);
    expect(result.note).toMatch(/405/);
    // A breadcrumb was left on the PR instead of failing silently.
    expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('/issues/42/comments'), expect.anything());
  });

  it('openPrForRequest dedupes duplicate target paths so the same file is never PUT twice', async () => {
    const svc = new InfraRepoSyncService();
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'base-commit-sha' } } });
      if (url.includes('/pulls')) return Promise.resolve({ data: [] }); // no existing PR for this branch
      if (url.includes('/contents/')) {
        return Promise.resolve({ data: { sha: 'base-sha', content: Buffer.from(VALUES, 'utf8').toString('base64') } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPost.mockImplementation((url: string) => {
      if (url.includes('/git/refs')) return Promise.resolve({ data: {} }); // createBranch
      if (url.includes('/pulls')) return Promise.resolve({ data: { number: 7, html_url: 'https://x', node_id: 'N7' } });
      return Promise.resolve({ data: {} });
    });
    mockPut.mockResolvedValue({ data: {} }); // putContent

    const dupPath = 'svc/prod/values-prod.yaml';
    const result = await svc.openPrForRequest({
      requestId: 'req-dup',
      secretName: 'Investment-Middleware-Secrets-Prod',
      proposedKeys: ['NEW_KEY'],
      targets: [
        { path: dupPath, manifestRef: 'Investment-Middleware-Secrets-Prod', format: 'helm-values' },
        { path: dupPath, manifestRef: 'Investment-Middleware-Secrets-Prod', format: 'helm-values' },
      ],
    });

    expect(result.state).toBe('OPEN');
    expect(result.filesChanged).toEqual([dupPath]); // not [dupPath, dupPath]
    const putContentCalls = mockPut.mock.calls.filter(([url]) => url.includes('/contents/'));
    expect(putContentCalls).toHaveLength(1); // would 409/422 on the 2nd call against a stale sha otherwise
  });

  it('openPrForRequest applies a per-file key subset — one file gets only the key it was scoped to', async () => {
    const svc = new InfraRepoSyncService();
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'base-commit-sha' } } });
      if (url.includes('/pulls')) return Promise.resolve({ data: [] }); // no existing PR for this branch
      if (url.includes('/contents/')) {
        return Promise.resolve({ data: { sha: 'base-sha', content: Buffer.from(VALUES, 'utf8').toString('base64') } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPost.mockImplementation((url: string) => {
      if (url.includes('/git/refs')) return Promise.resolve({ data: {} });
      if (url.includes('/pulls')) return Promise.resolve({ data: { number: 8, html_url: 'https://x', node_id: 'N8' } });
      return Promise.resolve({ data: {} });
    });
    const putCalls: any[] = [];
    mockPut.mockImplementation((url: string, body: any) => {
      putCalls.push({ url, body });
      return Promise.resolve({ data: {} });
    });

    const result = await svc.openPrForRequest({
      requestId: 'req-keysubset-live',
      secretName: 'Investment-Middleware-Secrets-Prod',
      proposedKeys: ['NEW_ONE', 'NEW_TWO'],
      // Requester scoped this single file to just NEW_ONE, excluding NEW_TWO even though it
      // was proposed for the request as a whole.
      targets: [
        { path: 'svc/prod/values-prod.yaml', manifestRef: 'Investment-Middleware-Secrets-Prod', format: 'helm-values', keys: ['NEW_ONE'] },
      ],
    });

    expect(result.state).toBe('OPEN');
    expect(result.keysAdded).toEqual(['NEW_ONE']);
    const written = putCalls.find(c => c.url.includes('/contents/'));
    expect(written.body.content).toBeDefined();
    const decoded = Buffer.from(written.body.content, 'base64').toString('utf8');
    expect(decoded).toContain('NEW_ONE');
    expect(decoded).not.toContain('NEW_TWO');
  });

  it('auto-discovery never surfaces a SecretProviderClass file, even when it references the secret', async () => {
    const svc = new InfraRepoSyncService();
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'commit-sha' } } });
      if (url.includes('/git/commits/')) return Promise.resolve({ data: { tree: { sha: 'tree-sha' } } });
      if (url.includes('/git/trees/')) {
        return Promise.resolve({
          data: {
            tree: [
              { path: 'svc/prod/values-prod.yaml', type: 'blob' },
              { path: 'auth-service/prod/secretproviderclass.yaml', type: 'blob' },
            ],
          },
        });
      }
      if (url.includes('/contents/svc%2Fprod%2Fvalues-prod.yaml') || url.includes('/contents/svc/prod/values-prod.yaml')) {
        return Promise.resolve({ data: { sha: 'sha-values', content: Buffer.from(VALUES, 'utf8').toString('base64') } });
      }
      // SPC content DOES reference Auth-Service-Secrets-Prod — if it were fetched/scanned
      // at all, this secret would wrongly show up as a consumer.
      return Promise.resolve({ data: { sha: 'sha-spc', content: Buffer.from(SPC, 'utf8').toString('base64') } });
    });

    const targets = await svc.resolveTargets('Auth-Service-Secrets-Prod', ['FAST2SMS_API_KEY']);
    expect(targets).toHaveLength(0);
    // The SPC file's content was never even requested — proves exclusion happens at
    // discovery (tree filtering), not just at edit time.
    const spcContentFetch = mockGet.mock.calls.some(([url]) => String(url).includes('secretproviderclass'));
    expect(spcContentFetch).toBe(false);
  });

  it('openPrForRequest DOES edit a manually-selected SecretProviderClass target — never auto-chosen, but editable when the requester adds it themselves', async () => {
    const svc = new InfraRepoSyncService();
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'commit-sha' } } });
      if (url.includes('/pulls')) return Promise.resolve({ data: [] }); // no existing PR for this branch
      if (url.includes('/contents/')) {
        return Promise.resolve({ data: { sha: 'sha-spc', content: Buffer.from(SPC, 'utf8').toString('base64') } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPost.mockImplementation((url: string) => {
      if (url.includes('/git/refs')) return Promise.resolve({ data: {} }); // createBranch
      if (url.includes('/pulls')) return Promise.resolve({ data: { number: 9, html_url: 'https://x', node_id: 'N9' } });
      return Promise.resolve({ data: {} });
    });
    mockPut.mockResolvedValue({ data: {} }); // putContent

    const result = await svc.openPrForRequest({
      requestId: 'req-spc-manual',
      secretName: 'Auth-Service-Secrets-Prod',
      proposedKeys: ['FAST2SMS_API_KEY'],
      targets: [{ path: 'auth-service/prod/secretproviderclass.yaml', manifestRef: 'Auth-Service-Secrets-Prod', format: 'spc' }],
    });

    expect(result.state).toBe('OPEN');
    expect(result.keysAdded).toEqual(['FAST2SMS_API_KEY']);
    const putContentCalls = mockPut.mock.calls.filter(([url]) => url.includes('/contents/'));
    expect(putContentCalls).toHaveLength(1);
  });

  it('openPrForRequest reports an unmatched-structure SKIPPED note, not "already present", when the manifest shape is unrecognized', async () => {
    // Regression for the misleading-SKIPPED-note bug: a mapping that references the secret
    // but has no `items:` list (a shape the scan doesn't understand) must not be reported the
    // same way as "every key already present" — the key genuinely never got registered.
    const shapeMismatch = `secretsStore:
  mappings:
    - awsSecretName: Shape-Mismatch-Secret
      items: []
`;
    const svc = new InfraRepoSyncService();
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'commit-sha' } } });
      if (url.includes('/pulls')) return Promise.resolve({ data: [] }); // no existing PR for this branch
      if (url.includes('/contents/')) {
        return Promise.resolve({ data: { sha: 'sha-mismatch', content: Buffer.from(shapeMismatch, 'utf8').toString('base64') } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const result = await svc.openPrForRequest({
      requestId: 'req-shape-mismatch',
      secretName: 'Shape-Mismatch-Secret',
      proposedKeys: ['NEW_KEY'],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Shape-Mismatch-Secret', format: 'helm-values' }],
    });

    expect(result.state).toBe('SKIPPED');
    expect(result.note).toMatch(/unrecognized structure/);
    expect(result.note).toContain('svc/prod/values-prod.yaml');
    expect(result.note).not.toMatch(/already present/);
    // No branch/PR should have been created for an unmatched-only result.
    expect(mockPost).not.toHaveBeenCalledWith(expect.stringContaining('/git/refs'), expect.anything());
  });

  it('openPrForRequest includes requesterName and email in body and [Hermes] in title', async () => {
    const svc = new InfraRepoSyncService();
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'base-commit-sha' } } });
      if (url.includes('/pulls')) return Promise.resolve({ data: [] });
      if (url.includes('/contents/')) {
        return Promise.resolve({ data: { sha: 'base-sha', content: Buffer.from(VALUES, 'utf8').toString('base64') } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    let prPayload: any = null;
    mockPost.mockImplementation((url: string, body: any) => {
      if (url.includes('/git/refs')) return Promise.resolve({ data: {} });
      if (url.includes('/pulls')) {
        prPayload = body;
        return Promise.resolve({ data: { number: 10, html_url: 'https://x', node_id: 'N10' } });
      }
      return Promise.resolve({ data: {} });
    });
    mockPut.mockResolvedValue({ data: {} });

    await svc.openPrForRequest({
      requestId: 'req-username-test',
      secretName: 'Investment-Middleware-Secrets-Prod',
      proposedKeys: ['NEW_KEY'],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Investment-Middleware-Secrets-Prod', format: 'helm-values' }],
      requesterName: 'admin-alice',
      requesterEmail: 'alice@bachatt.com',
    });

    expect(prPayload).toBeDefined();
    expect(prPayload.title).toBe('[Hermes] chore(secrets): register 1 key(s) in Investment-Middleware-Secrets-Prod');
    expect(prPayload.body).toContain('**Requested by:** admin-alice (alice@bachatt.com)');
  });

  // --- markReady / merge diagnostics (auto-merge path) ---

  /** Shared live-mode wiring for the merge path; `graphql` decides what markReady returns. */
  const mergeHarness = (opts: { graphql: any; mergeError?: any }) => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'base-commit-sha' } } });
      if (url.includes('/git/commits/')) return Promise.resolve({ data: { tree: { sha: 'base-tree-sha' } } });
      if (url.includes('/contents/')) {
        return Promise.resolve({ data: { sha: 'base-sha', content: Buffer.from(VALUES, 'utf8').toString('base64') } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPost.mockImplementation((url: string) => {
      if (url.includes('/graphql')) return Promise.resolve({ data: opts.graphql });
      if (url.includes('/git/blobs')) return Promise.resolve({ data: { sha: 'blob-sha' } });
      if (url.includes('/git/trees')) return Promise.resolve({ data: { sha: 'tree-sha' } });
      if (url.includes('/git/commits')) return Promise.resolve({ data: { sha: 'new-commit-sha' } });
      return Promise.resolve({ data: {} }); // comment
    });
    mockPut.mockImplementation((url: string) => {
      if (url.includes('/merge')) {
        if (opts.mergeError) return Promise.reject(opts.mergeError);
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({ data: {} });
    });
    mockPatch.mockResolvedValue({ data: {} });

    return new InfraRepoSyncService().mergePrForRequest({
      request: {
        id: 'req-1',
        secretName: 'Investment-Middleware-Secrets-Prod',
        infraPrNumber: 42,
        infraPrNodeId: 'PR_node',
        infraBranch: 'hermes/secret-keys/investment-middleware-secrets-prod-req-1',
      },
      approvedKeys: ['NEW_KEY'],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Investment-Middleware-Secrets-Prod', format: 'helm-values' }],
    });
  };

  it('markReady surfaces a GraphQL error instead of merging a still-draft PR', async () => {
    // GraphQL reports mutation failures in a 200 body, so this used to resolve as success:
    // the PR stayed a draft and the failure resurfaced as an unexplained 405 from the merge.
    const result = await mergeHarness({
      graphql: { errors: [{ message: 'Resource not accessible by integration' }] },
    });

    expect(result.state).toBe('FAILED');
    expect(result.note).toMatch(/Resource not accessible by integration/);
    // The real point: we never attempted a merge we knew would fail.
    expect(mockPut).not.toHaveBeenCalledWith(expect.stringContaining('/merge'), expect.anything());
  });

  it('markReady treats "not a draft" as already-done and proceeds to merge', async () => {
    // The retry path and the submit/review race both re-run markReady against a PR an
    // earlier pass already flipped — that must stay a no-op, not become a failure.
    const result = await mergeHarness({
      graphql: { errors: [{ message: 'Pull request is not a draft' }] },
    });

    expect(result.state).toBe('MERGED');
    expect(mockPut).toHaveBeenCalledWith(expect.stringContaining('/pulls/42/merge'), expect.anything());
  });

  it('a 405 merge failure quotes GitHub\'s own reason rather than asserting branch protection', async () => {
    const err: any = new Error('blocked');
    err.response = { status: 405, data: { message: 'Draft pull requests cannot be merged.' } };
    const result = await mergeHarness({ graphql: {}, mergeError: err });

    expect(result.state).toBe('FAILED');
    expect(result.note).toMatch(/Draft pull requests cannot be merged/);
  });

  // --- readyPrForRequest (manual review path) ---

  const readyHarness = (opts: { graphql: any }) => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/git/ref/heads/')) return Promise.resolve({ data: { object: { sha: 'base-commit-sha' } } });
      if (url.includes('/git/commits/')) return Promise.resolve({ data: { tree: { sha: 'base-tree-sha' } } });
      if (url.includes('/contents/')) {
        return Promise.resolve({ data: { sha: 'base-sha', content: Buffer.from(VALUES, 'utf8').toString('base64') } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPost.mockImplementation((url: string) => {
      if (url.includes('/graphql')) return Promise.resolve({ data: opts.graphql });
      if (url.includes('/git/blobs')) return Promise.resolve({ data: { sha: 'blob-sha' } });
      if (url.includes('/git/trees')) return Promise.resolve({ data: { sha: 'tree-sha' } });
      if (url.includes('/git/commits')) return Promise.resolve({ data: { sha: 'new-commit-sha' } });
      return Promise.resolve({ data: {} }); // comment
    });
    mockPatch.mockResolvedValue({ data: {} }); // reopen + reset ref

    return new InfraRepoSyncService().readyPrForRequest({
      request: {
        id: 'req-1',
        secretName: 'Investment-Middleware-Secrets-Prod',
        infraPrNumber: 42,
        infraPrNodeId: 'PR_node',
        infraBranch: 'hermes/secret-keys/investment-middleware-secrets-prod-req-1',
      },
      approvedKeys: ['NEW_KEY'],
      targets: [{ path: 'svc/prod/values-prod.yaml', manifestRef: 'Investment-Middleware-Secrets-Prod', format: 'helm-values' }],
    });
  };

  it('readyPrForRequest recomputes the branch, comments on the PR, reopens the PR, and flips it to ready', async () => {
    const result = await readyHarness({ graphql: {} });

    expect(result.state).toBe('OPEN');
    expect(result.keysAdded).toEqual(['NEW_KEY']);
    expect(mockPatch).toHaveBeenCalledWith(expect.stringContaining('/pulls/42'), { state: 'open' });
    expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('/issues/42/comments'), expect.objectContaining({
      body: expect.stringContaining('Hermes: request reviewed')
    }));
    const gqlCall = mockPost.mock.calls.find(([url]) => url.includes('/graphql'));
    expect(gqlCall).toBeDefined();
    expect(gqlCall[1].variables.id).toBe('PR_node');
  });

  it('readyPrForRequest returns FAILED when markReady fails with GraphQL errors', async () => {
    const result = await readyHarness({
      graphql: { errors: [{ message: 'GraphQL write blocked' }] },
    });

    expect(result.state).toBe('FAILED');
    expect(result.note).toMatch(/GraphQL write blocked/);
  });
});

