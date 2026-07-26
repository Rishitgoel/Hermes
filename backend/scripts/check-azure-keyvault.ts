/**
 * Live Azure Key Vault preflight — run this BEFORE trusting the Azure Secret Ingestion instance.
 *
 * Everything in the test suite exercises the in-process simulation. This script is the only thing
 * that proves the real path works: service-principal auth, the paginated list, per-secret reads,
 * a write, and — the part most likely to be wrong — that Azure's error objects actually carry the
 * fields `KeyVaultService.toAzureError` switches on (`.statusCode` / `.code`). If they don't, a
 * 403 "the service principal has no access policy on this vault" degrades into a generic 502 and
 * whoever is debugging go-live gets no useful message.
 *
 * Defaults to the real instance (`secrets-azure`), read-only unless you also pass --write.
 *
 * Usage, from backend/:
 *   npx ts-node scripts/check-azure-keyvault.ts                      # read-only
 *   npx ts-node scripts/check-azure-keyvault.ts --write              # + write/read-back/cleanup
 *   npx ts-node scripts/check-azure-keyvault.ts --instance <key>      # a different configured instance
 *
 * Requires (in backend/.env):
 *   SECRETS_AZURE_VAULT_NAME (or SECRETS_AZURE_SUBSCRIPTION_ID for discovery mode), _TENANT_ID,
 *   _CLIENT_ID, _CLIENT_SECRET, SECRETS_AZURE_SIMULATION=false
 */
import 'dotenv/config';
import config from '../src/config/config';
import { getSecretsManagerService } from '../src/services/secrets-manager.service';
import { SecretsInstanceConfig } from '../src/services/secret-store.interface';

/**
 * `config.secretsInstances` is a union of the AWS- and Azure-shaped entries, so the Azure-only
 * fields aren't on the union. Narrow to the shared contract the stores actually consume.
 */
type AzureInstance = SecretsInstanceConfig & { enabled: boolean };

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const INSTANCE = opt('instance') || 'secrets-azure';
const DO_WRITE = flag('write');
/** Prefixed so it is obviously disposable, and easy to spot if cleanup ever fails. */
const PROBE_KEY = 'hermes-preflight-probe';

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m: string) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    failures++;
    bad(`${name} — ${err?.name || 'Error'}: ${err?.message || err}`);
    if (err?.context) {
      info(`context: ${JSON.stringify(err.context)}`);
    }
  }
}

async function main() {
  console.log('\nAzure Key Vault preflight\n' + '─'.repeat(60));

  const instance = config.secretsInstances.find(i => i.key === INSTANCE) as
    | AzureInstance
    | undefined;
  if (!instance) {
    console.error(
      `\nNo Secret Ingestion instance "${INSTANCE}". Configured: ` +
        config.secretsInstances.map(i => i.key).join(', ') +
        '\n',
    );
    process.exit(1);
  }
  if (!instance.enabled) {
    console.error(
      `\nInstance "${INSTANCE}" is not enabled. Set SECRETS_AZURE_VAULT_NAME (or SECRETS_AZURE_SUBSCRIPTION_ID) in backend/.env.\n`,
    );
    process.exit(1);
  }
  if (instance.isSimulation) {
    console.error(
      `\nInstance "${INSTANCE}" is in SIMULATION mode — this script would prove nothing.\n` +
        'Set the vault name and SECRETS_AZURE_SIMULATION=false.\n',
    );
    process.exit(1);
  }

  const pinned = instance.vaultName;
  info(`instance : ${INSTANCE}`);
  info(
    `mode     : ${pinned ? `PINNED to ${pinned}` : `DISCOVERY (subscription ${instance.subscriptionId || 'MISSING'})`}`,
  );
  info(`tenant   : ${instance.tenantId ? 'set' : 'MISSING'}`);
  info(`client   : ${instance.clientId ? 'set' : 'MISSING'}`);
  info(`secret   : ${instance.clientSecret ? 'set' : 'MISSING'}`);
  info(`writes   : ${DO_WRITE ? 'ENABLED' : 'read-only (pass --write to test writes)'}`);
  console.log('');

  const svc = getSecretsManagerService(INSTANCE);

  // 1 — auth + network + reachability, in one cheap call.
  await step('healthCheck', async () => {
    const res = await svc.healthCheck();
    if (!res.healthy) {
      throw new Error(res.message || 'unhealthy');
    }
    ok('healthCheck — auth, network and vault access all working');
  });

  // 2 — vault discovery. In DISCOVERY mode this is the ARM (management-plane) call, which uses a
  //     DIFFERENT permission from reading secrets: it is entirely normal to have one and not the
  //     other, and the failure looks like "no vaults" rather than an auth error.
  let vault = pinned || '';
  await step('listAllSecrets (vault discovery)', async () => {
    const vaults = await svc.listAllSecrets();
    if (vaults.length === 0) {
      throw new Error(
        'no vaults visible — the service principal likely lacks a Reader role at subscription scope',
      );
    }
    ok(`discovered ${vaults.length} vault(s)`);
    info(`${vaults.slice(0, 10).join(', ')}${vaults.length > 10 ? ' …' : ''}`);
    if (!vault) {
      vault = vaults[0];
      info(`probing "${vault}" for the data-plane checks below`);
    } else if (!vaults.some(v => v.toLowerCase() === vault.toLowerCase())) {
      throw new Error(`pinned vault "${vault}" is not among the visible vaults`);
    }
  });

  if (!vault) {
    console.log('─'.repeat(60));
    console.log('\x1b[31mNo vault to probe — stopping.\x1b[0m\n');
    process.exit(1);
  }

  // 3 — the paginated per-vault list. This is the DATA-plane call every keys read is built on.
  let keys: string[] = [];
  await step('listSecretKeys', async () => {
    const res = await svc.listSecretKeys(vault);
    if (!res.exists) {
      throw new Error('vault reported as not existing');
    }
    keys = res.keys;
    ok(`listSecretKeys — ${keys.length} secret(s) in ${vault}`);
    if (keys.length) {
      info(`sample: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ' …' : ''}`);
    }
  });

  // 3 — the narrowed read the approvals queue uses. Values are NOT printed.
  await step('getSecretMap (narrowed)', async () => {
    if (keys.length === 0) {
      info('getSecretMap — skipped, vault is empty');
      return;
    }
    const probe = keys.slice(0, 2);
    const map = await svc.getSecretMap(vault, probe);
    const got = probe.filter(k => map && map[k] !== undefined);
    ok(`getSecretMap — resolved ${got.length}/${probe.length} value(s) (not printed)`);
  });

  // 4 — a name the vault will never hold: proves "missing key" is null, not an exception.
  await step('getSecretMap (absent key ⇒ no value, not an error)', async () => {
    const map = await svc.getSecretMap(vault, ['hermes-definitely-absent-key']);
    if (map && map['hermes-definitely-absent-key'] !== undefined) {
      throw new Error('an absent key somehow returned a value');
    }
    ok('absent key handled as "no value" rather than throwing');
  });

  // 5 — THE important one. Every Hermes error message for Azure depends on toAzureError reading
  //     the SDK's real error shape. An invalid name must come back as a 400-mapped ValidationError.
  await step('error mapping (invalid name ⇒ ValidationError)', async () => {
    try {
      await svc.putSecretKeyValues(
        vault,
        { 'invalid_name_with_underscores': 'x' },
        { createIfMissing: false },
      );
      throw new Error('expected the invalid name to be rejected, but the write succeeded');
    } catch (err: any) {
      if (err?.errorCode === 'VALIDATION_ERROR') {
        ok(`invalid name rejected as ValidationError — "${String(err.message).slice(0, 80)}…"`);
        return;
      }
      throw new Error(
        `expected VALIDATION_ERROR, got ${err?.errorCode || err?.name}: ${err?.message}`,
      );
    }
  });

  // 6 — write + read back + clean up. Opt-in.
  if (DO_WRITE) {
    await step('putSecretKeyValues → read back → cleanup', async () => {
      const value = `preflight-${Date.now()}`;
      await svc.putSecretKeyValues(vault, { [PROBE_KEY]: value }, { createIfMissing: true });
      ok(`wrote ${PROBE_KEY}`);

      const back = await svc.getSecretMap(vault, [PROBE_KEY]);
      if (back?.[PROBE_KEY] !== value) {
        throw new Error(
          `read-back mismatch: expected the value just written, got ${back?.[PROBE_KEY] === undefined ? 'nothing' : 'something else'}`,
        );
      }
      ok('read back the exact value written');

      const after = await svc.listSecretKeys(vault);
      if (!after.keys.includes(PROBE_KEY)) {
        throw new Error(
          'the new key is missing from listSecretKeys — the name cache was not invalidated after the write',
        );
      }
      ok('new key appears in the list immediately (cache invalidation works)');

      // Key Vault has no "delete one version" — the probe key is left in place deliberately
      // rather than issuing a delete this service has no method for. Remove it by hand.
      info(`⚠ leftover: delete "${PROBE_KEY}" from ${vault} in the Azure portal when done`);
    });
  } else {
    info('write test skipped (pass --write to run it)');
  }

  console.log('─'.repeat(60));
  if (failures) {
    console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m Do not go live until these pass.\n`);
    process.exit(1);
  }
  console.log('\x1b[32mAll checks passed.\x1b[0m\n');
}

main().catch(err => {
  console.error('\nPreflight crashed:', err);
  process.exit(1);
});
