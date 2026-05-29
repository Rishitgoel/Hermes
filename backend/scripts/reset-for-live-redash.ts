/**
 * One-shot reset for switching Hermes from mock Redash to a real Redash instance.
 *
 * What it does:
 *  1. Wipes all transient state (access requests, grants, audits, notifications,
 *     user-creation requests, GroupAdmin seeds, and the RedashUser/RedashGroup
 *     cache).
 *  2. Keeps the Hermes Group rows (with their descriptions, icons, tables) but
 *     re-maps each Group.externalGroupId to the matching live Redash group ID
 *     by name lookup against the configured REDASH_BASE_URL / REDASH_API_KEY.
 *
 * Usage (from backend/):
 *   npx ts-node scripts/reset-for-live-redash.ts
 *
 * Safe to re-run. Will NOT touch Hermes Group business config beyond
 * externalGroupId, and will NOT delete the Group rows themselves.
 */

import axios from 'axios';
import prisma from '../src/config/prisma';
import config from '../src/config/config';
import { execSync } from 'child_process';

interface RedashGroup {
  id: number;
  name: string;
  type: string;
}

async function fetchLiveRedashGroups(): Promise<RedashGroup[]> {
  const url = `${config.redash.baseUrl.replace(/\/$/, '')}/api/groups`;
  const res = await axios.get(url, {
    headers: { Authorization: `Key ${config.redash.apiKey}` },
    timeout: 10000,
  });
  return res.data;
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Hermes reset → live Redash');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Target:    ${config.redash.baseUrl}`);
  console.log(`  API key:   ${config.redash.apiKey.slice(0, 6)}…${config.redash.apiKey.slice(-4)}`);
  console.log(`  Simulation: reads=${config.redash.isSimulation ? 'SIM' : 'LIVE'}`);
  console.log('');

  if (config.redash.isSimulation) {
    console.error(
      '✗ Refusing to run: Redash is still in simulation mode. ' +
        'Set REDASH_SIMULATION=false and a real REDASH_API_KEY in backend/.env first.',
    );
    process.exit(1);
  }

  // ── 1. Smoke-test the API key BEFORE we delete anything ──────────────
  console.log('Step 1/3 — Verifying Redash API key against live instance…');
  let liveGroups: RedashGroup[];
  try {
    liveGroups = await fetchLiveRedashGroups();
  } catch (err: any) {
    const status = err.response?.status;
    console.error(`✗ Could not reach Redash (${status ?? 'no response'}): ${err.message}`);
    console.error('  Nothing was deleted. Fix REDASH_BASE_URL / REDASH_API_KEY and retry.');
    process.exit(1);
  }
  console.log(`  ✓ Found ${liveGroups.length} live Redash groups:`);
  for (const g of liveGroups) console.log(`     [${g.id}] ${g.name} (${g.type})`);
  console.log('');

  // ── 1.5. Clean up non-admin users in Redash database ──────────────────
  // Only runs when REDASH_BASE_URL points at the local docker stack. For a
  // remote Redash (e.g. redash.bachatt.app) we have no business issuing
  // `docker exec` against a container that does not exist on this machine and
  // would not own that data anyway — exec-ing the local container while the
  // API key points to prod would leave the two ends desynchronized.
  const isLocalRedash = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(
    config.redash.baseUrl,
  );

  if (isLocalRedash) {
    console.log('Step 1.5/3 — Deleting non-admin users from local Redash PostgreSQL container…');
    try {
      const checkDocker = execSync('docker ps -q -f name=hermes_redash_postgres', { encoding: 'utf8' }).trim();
      if (checkDocker) {
        // Clear events first to prevent FK violation
        execSync('docker exec -i hermes_redash_postgres psql -U redash -d redash -c "DELETE FROM events WHERE user_id > 1;"', { stdio: 'ignore' });
        // Clear users
        execSync('docker exec -i hermes_redash_postgres psql -U redash -d redash -c "DELETE FROM users WHERE id > 1;"', { stdio: 'ignore' });
        console.log('  ✓ Deleted non-admin users from Redash PostgreSQL.');
      } else {
        console.log('  ✗ Redash Postgres container (hermes_redash_postgres) is not running; skipping user cleanup.');
      }
    } catch (err: any) {
      console.log(`  ✗ Failed to delete users from Redash Postgres: ${err.message}`);
    }
  } else {
    console.log('Step 1.5/3 — Remote Redash detected; skipping local container user wipe.');
    console.log('  ⚠ Hermes-side state will be wiped, but Redash users on');
    console.log(`     ${config.redash.baseUrl} are untouched.`);
    console.log('     Disable / delete unwanted users via the Redash admin UI manually.');
  }
  console.log('');

  // ── 2. Wipe transient state ──────────────────────────────────────────
  console.log('Step 2/3 — Wiping transient state…');
  // Order matters for FKs:
  //   AuditEntry → AccessRequest (nullable, but delete first to be safe)
  //   UserAccess → Group   (keep Group, delete UserAccess)
  //   AccessRequest → Group
  //   GroupAdmin → Group
  const wipes: Array<[string, () => Promise<{ count: number }>]> = [
    ['notifications', () => prisma.notification.deleteMany({})],
    ['audit_entries', () => prisma.auditEntry.deleteMany({})],
    ['user_accesses', () => prisma.userAccess.deleteMany({})],
    ['access_requests', () => prisma.accessRequest.deleteMany({})],
    ['user_creation_requests', () => prisma.userCreationRequest.deleteMany({})],
    ['group_admins', () => prisma.groupAdmin.deleteMany({})],
    ['redash_users', () => prisma.redashUser.deleteMany({})],
    ['redash_groups', () => prisma.redashGroup.deleteMany({})],
  ];
  for (const [label, fn] of wipes) {
    const r = await fn();
    console.log(`  ✓ ${label.padEnd(24, ' ')} deleted ${r.count}`);
  }
  console.log('');

  // ── 3. Re-map Hermes Group.externalGroupId by name ──────────────────
  console.log('Step 3/3 — Remapping Hermes Group.externalGroupId to live Redash IDs…');
  const hermesGroups = await prisma.group.findMany({ orderBy: { name: 'asc' } });
  const byName = new Map(liveGroups.map((g) => [g.name.trim().toLowerCase(), g]));
  let mapped = 0;
  let unmapped: string[] = [];
  for (const hg of hermesGroups) {
    const match = byName.get(hg.name.trim().toLowerCase());
    if (!match) {
      unmapped.push(hg.name);
      console.log(`  ✗ ${hg.name.padEnd(20, ' ')} no matching Redash group (skipped)`);
      continue;
    }
    const newExternalId = String(match.id);
    if (hg.externalGroupId === newExternalId) {
      console.log(`  · ${hg.name.padEnd(20, ' ')} already mapped → ${newExternalId}`);
      continue;
    }
    await prisma.group.update({
      where: { id: hg.id },
      data: { externalGroupId: newExternalId },
    });
    console.log(
      `  ✓ ${hg.name.padEnd(20, ' ')} ${hg.externalGroupId ?? '(null)'} → ${newExternalId}`,
    );
    mapped++;
  }
  console.log('');
  console.log(`  Mapped ${mapped} group(s). Unmapped: ${unmapped.length === 0 ? 'none' : unmapped.join(', ')}`);

  if (unmapped.length > 0) {
    console.log('');
    console.log('  Heads-up: unmapped Hermes groups will not provision against Redash.');
    console.log('  Either create matching groups in Redash UI (same name) or delete the');
    console.log('  Hermes Group rows you don\'t need.');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Done. Restart the backend (`npm run dev`) to trigger');
  console.log('  the initial live sync and start exercising the flow.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((err) => {
    console.error('Reset failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
