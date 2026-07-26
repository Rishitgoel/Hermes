// Simulation enabled with NO vault name — the setup backend/.env.example documents for local
// testing. Must be set before config is imported. Deliberately its own file: the other Azure
// suites set SECRETS_AZURE_VAULT_NAME at module scope, which is exactly what masked this.
process.env.SECRETS_AZURE_SIMULATION = 'true';
delete process.env.SECRETS_AZURE_VAULT_NAME;

import { describe, it, expect } from 'vitest';
import config, { SIM_AZURE_VAULT_NAME } from '../config/config';
import { getSecretsManagerService } from './secrets-manager.service';

/**
 * Regression: `SECRETS_AZURE_SIMULATION=true` on its own used to register the adapter while
 * leaving vaultName undefined, so KeyVaultService's `vaultName` getter threw on EVERY call —
 * listAllSecrets, listSecretKeys, getSecretMap, putSecretKeyValues. The instance existed in the
 * chooser and 500'd on contact.
 */
describe('Azure Key Vault — simulation with no vault name configured', () => {
  const instance = () =>
    config.secretsInstances.find((i) => i.key === 'secrets-azure')!;

  it('is enabled and runs in discovery mode (no vault pin)', () => {
    expect(instance().enabled).toBe(true);
    expect(instance().isSimulation).toBe(true);
    // No pin: the instance discovers vaults rather than being bound to one, which is the same
    // shape it has live.
    expect(instance().vaultName).toBeUndefined();
  });

  it('never surfaces the production vault name', async () => {
    // A simulated instance must not be mistakable for prod in a group's externalGroupId or an
    // audit row.
    const svc = getSecretsManagerService('secrets-azure');
    expect(await svc.listAllSecrets()).not.toContain('bachatt-prod-kv');
  });

  it('serves the whole read/write path instead of throwing', async () => {
    // NB: no __resetSim() here — it deliberately leaves the store EMPTY (same as the AWS store),
    // and this file is about what the instance serves out of the box.
    const svc = getSecretsManagerService('secrets-azure');

    // Discovery returns the seeded mock vaults — more than one, so the vault picker is exercised.
    const vaults = await svc.listAllSecrets();
    expect(vaults).toContain(SIM_AZURE_VAULT_NAME);
    expect(vaults.length).toBeGreaterThan(1);

    const listed = await svc.listSecretKeys(SIM_AZURE_VAULT_NAME);
    expect(listed.exists).toBe(true);
    expect(listed.keys).toContain('orbit-kfin-username');

    await svc.putSecretKeyValues(
      SIM_AZURE_VAULT_NAME,
      { 'orbit-sim-key': 'sim-value' },
      { createIfMissing: true },
    );
    const map = await svc.getSecretMap(SIM_AZURE_VAULT_NAME, ['orbit-sim-key']);
    expect(map?.['orbit-sim-key']).toBe('sim-value');
  });
});
