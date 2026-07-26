/**
 * Live infra-deployment manifest dry-run for the Azure (Key Vault) instance — READ ONLY.
 *
 * The Azure manifest editor has only ever been tested against fixtures written by hand from a
 * description of `azure/orbit` and `azure/saathi-be`. This script points it at the REAL repo and
 * reports what it finds and what it would change, without writing anything, opening a branch, or
 * touching a PR. If the real files differ in shape from the fixtures, the editor silently reports
 * `not-referenced`/`unmatched` and requests quietly open no PR — this is how you find that out
 * before a requester does.
 *
 * Usage, from backend/:
 *   npx ts-node scripts/check-azure-manifests.ts
 *   npx ts-node scripts/check-azure-manifests.ts --vault Bachatt
 *   npx ts-node scripts/check-azure-manifests.ts --key orbit-new-thing --env-var CUSTOM_NAME
 *
 * Requires a GitHub token with read access to the infra-deployment repo (INFRA_REPO_TOKEN, or the
 * instance's own SECRETS_AZURE*_INFRA_REPO_TOKEN). The vault is either the instance's pin
 * (SECRETS_AZURE_VAULT_NAME) or, in discovery mode, the FIRST vault discovered — pass --vault to
 * pick a specific one.
 */
import 'dotenv/config';
import config from '../src/config/config';
import {
  InfraRepoConfig,
  InfraRepoSyncService,
  editAzureValuesMappings,
  registeredKeysInFile,
} from '../src/services/infra-repo-sync.service';
import { getSecretsManagerService } from '../src/services/secrets-manager.service';
import {
  SecretsInstanceConfig,
  deriveEnvVar,
} from '../src/services/secret-store.interface';

/**
 * `config.secretsInstances` is a union of the AWS- and Azure-shaped entries, so the Azure-only
 * fields aren't on the union. Narrow to what this script reads.
 */
type AzureInstance = SecretsInstanceConfig & { infraRepo: InfraRepoConfig };

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const INSTANCE = opt('instance') || 'secrets-azure';
const VAULT_ARG = opt('vault');
/** A name that cannot already exist, so "what would be added" is always exercised. */
const PROBE_KEY = opt('key') || `orbit-hermes-dryrun-${Date.now()}`;
const PROBE_ENV = opt('env-var');

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const info = (m: string) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

async function main() {
  console.log('\ninfra-deployment Azure manifest dry-run (read-only)\n' + '─'.repeat(64));

  const instance = config.secretsInstances.find(i => i.key === INSTANCE) as
    | AzureInstance
    | undefined;
  if (!instance) {
    console.error(`\nNo Secret Ingestion instance "${INSTANCE}".\n`);
    process.exit(1);
  }
  const infraCfg = instance.infraRepo;

  // Pinned instances have exactly one vault; discovery instances have none configured up front —
  // resolve the actual set live, same as the app does, rather than assuming a single name.
  let vault = instance.vaultName || VAULT_ARG;
  if (!vault) {
    const svc = getSecretsManagerService(INSTANCE);
    const vaults = await svc.listAllSecrets();
    if (vaults.length === 0) {
      console.error(
        `\nInstance "${INSTANCE}" is in discovery mode but no vaults are visible (check the ` +
          'service principal\'s Reader role on the subscription).\n',
      );
      process.exit(1);
    }
    vault = vaults[0];
    if (vaults.length > 1) {
      console.log(
        `  (discovered ${vaults.length} vaults: ${vaults.join(', ')} — using "${vault}"; pass --vault to pick another)\n`,
      );
    }
  } else if (VAULT_ARG && instance.vaultName && VAULT_ARG.toLowerCase() !== instance.vaultName.toLowerCase()) {
    console.error(
      `\nInstance "${INSTANCE}" is pinned to "${instance.vaultName}" — --vault ${VAULT_ARG} is ignored. ` +
        'Unset the pin (or point --instance at a discovery-mode instance) to check a different vault.\n',
    );
    process.exit(1);
  }
  if (infraCfg.isSimulation) {
    console.error(
      '\nThe infra-deployment mirror is in SIMULATION for this instance — this script would read ' +
        'fabricated manifests and prove nothing. Set a real INFRA_REPO_TOKEN.\n',
    );
    process.exit(1);
  }

  info(`instance : ${INSTANCE}`);
  info(`vault    : ${vault}`);
  info(`repo     : ${infraCfg.owner}/${infraCfg.repo}@${infraCfg.baseBranch}`);
  info(`scope    : ${infraCfg.pathInclude ?? '(whole repo)'}`);
  info(`probe key: ${PROBE_KEY} → ${PROBE_ENV || deriveEnvVar(PROBE_KEY) + ' (derived)'}`);
  console.log('');

  const svc = new InfraRepoSyncService(infraCfg);

  // resolveTargets is the exact call the compose screen makes. Read-only: it diffs the live files
  // and reports, committing nothing.
  const targets = await svc.resolveTargets(
    vault,
    [PROBE_KEY],
    [],
    PROBE_ENV ? { [PROBE_KEY]: PROBE_ENV } : undefined,
  );

  if (targets.length === 0) {
    bad(
      `No manifest under "${infraCfg.pathInclude ?? '/'}" declares keyvaultName: ${vault}.`,
    );
    console.log('');
    console.log('  This is the failure mode to care about: every ingestion request for this vault');
    console.log('  would open NO PR at all, silently. Check that:');
    console.log(`    · the manifests really say "keyvaultName: ${vault}" (exact vault name)`);
    console.log('    · they are named values-*.yaml (values.yaml alone is never scanned)');
    console.log(`    · they live under the "${infraCfg.pathInclude}" prefix`);
    console.log('    · the token can actually read the repo\n');
    process.exit(1);
  }

  ok(`${targets.length} manifest(s) consume this vault`);
  console.log('');

  let unmatched = 0;
  let editable = 0;

  for (const t of targets) {
    console.log(`  \x1b[1m${t.path}\x1b[0m  (${t.format}, env=${t.env ?? '—'})`);

    const file = await (svc as any).getContent(t.path, infraCfg.baseBranch);
    if (!file) {
      bad('could not read the file back');
      continue;
    }

    const reg = registeredKeysInFile(t.path, file.content, vault, 'azure');
    if (reg.unmatched) {
      unmatched++;
      warn('mappings list NOT understood — Hermes would refuse to edit this file');
      const res = editAzureValuesMappings(file.content, vault, [PROBE_KEY]);
      if (res.status === 'unmatched' && res.reason) {
        info(`reason: ${res.reason}`);
      }
    } else {
      ok(`${reg.keys.length} registered key(s)`);
      info(
        `existing: ${reg.keys.slice(0, 6).join(', ')}${reg.keys.length > 6 ? ` … +${reg.keys.length - 6}` : ''}`,
      );
    }

    // What the probe key WOULD produce, shown as a diff fragment. Nothing is written.
    const res = editAzureValuesMappings(
      file.content,
      vault,
      [PROBE_KEY],
      PROBE_ENV ? { [PROBE_KEY]: PROBE_ENV } : undefined,
    );
    if (res.status === 'edited') {
      editable++;
      const before = file.content.split(/\r?\n/);
      const after = res.content.split(/\r?\n/);
      const added = after.filter((l, i) => l !== before[i] && !before.includes(l));
      console.log('    would add:');
      for (const l of added.slice(0, 4)) {
        console.log(`      \x1b[32m+${l}\x1b[0m`);
      }
    } else {
      info(`would not edit: ${res.status}${'reason' in res && res.reason ? ` — ${res.reason}` : ''}`);
    }
    console.log('');
  }

  console.log('─'.repeat(64));
  console.log(
    `  ${editable}/${targets.length} manifest(s) editable, ${unmatched} unreadable.`,
  );
  if (unmatched > 0) {
    console.log(
      '\n  \x1b[33mAt least one real manifest does not match the shape the editor expects.\x1b[0m',
    );
    console.log('  Paste that file into infra-repo-sync.azure.test.ts as a fixture and fix the parser');
    console.log('  before going live — requests targeting it would open no PR.\n');
    process.exit(1);
  }
  console.log('\n  \x1b[32mEvery real manifest parses and is editable.\x1b[0m\n');
}

main().catch(err => {
  console.error('\nDry-run crashed:', err?.message || err);
  process.exit(1);
});
