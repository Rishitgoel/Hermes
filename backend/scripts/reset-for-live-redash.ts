/**
 * One-shot reset for switching Hermes from mock Redash to a real Redash instance.
 *
 * What it does:
 *  1. Wipes all transient state (access requests, grants, audits, notifications,
 *     user-creation requests, PlatformAdmin / GroupAdmin seeds, and the Redash
 *     PlatformExternalUser / PlatformExternalGroup cache rows).
 *  2. Clears the Hermes-managed *scoped* admin roles from Keycloak
 *     (hermes_platform_admin_* / hermes_group_admin_*) and logs the affected
 *     users out. Without this, a previous admin gets reconciled straight back
 *     from their lingering Keycloak role after the DB mirror is wiped (the
 *     reconciliation job treats Keycloak as the source of truth), so they keep
 *     showing as an "active" admin of a group while absent from its members
 *     list. hermes_super_admin and the bare markers are left untouched; scoped
 *     roles are re-created on demand when admins are re-assigned via the UI.
 *  3. Keeps the Hermes Group rows (with their descriptions, icons, tables) but
 *     re-maps each Redash Group.externalGroupId to the matching live Redash
 *     group ID by name lookup against the configured REDASH_BASE_URL / REDASH_API_KEY.
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
import keycloakAdminService from '../src/services/keycloak-admin.service';
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
    ['platform_admins', () => prisma.platformAdmin.deleteMany({})],
    // Cache rows are platform-keyed (PlatformExternalUser/Group carry a
    // `platform` column). Only clear Redash's so a future AWS/Jira cache isn't
    // nuked by a Redash-only reset; the live Redash sync repopulates these.
    ['platform_external_users', () => prisma.platformExternalUser.deleteMany({ where: { platform: 'redash' } })],
    ['platform_external_groups', () => prisma.platformExternalGroup.deleteMany({ where: { platform: 'redash' } })],
  ];
  for (const [label, fn] of wipes) {
    const r = await fn();
    console.log(`  ✓ ${label.padEnd(24, ' ')} deleted ${r.count}`);
  }
  console.log('');

  // ── 2.5. Clear Hermes-managed scoped admin roles from Keycloak ───────
  // Step 2 wiped the DB admin mirrors (group_admins / platform_admins), but
  // those are only a mirror — Keycloak is the source of truth for who holds a
  // role. Leave the scoped roles assigned there and the reconciliation job (or
  // the next /auth/me) re-creates the very mirror rows we just deleted: a prior
  // admin (e.g. Uday on "customer support") pops back as a group admin —
  // auto-enrolled so they read as "active" for the group, yet missing from the
  // plain members list (admins are filtered out of it).
  //
  // So drop every Hermes scoped admin role (hermes_platform_admin_* /
  // hermes_group_admin_*) — definition and all its user mappings — and log the
  // affected users out so the role leaves their JWT immediately. The bare
  // markers (hermes_platform_admin / hermes_group_admin) and, crucially,
  // hermes_super_admin are left untouched. Scoped roles are re-created on demand
  // by the Admin Management UI (keycloakAdminService.ensureCompositeRole).
  console.log('Step 2.5/3 — Clearing Hermes-managed admin roles from Keycloak…');
  if (!keycloakAdminService.isLive) {
    console.log('  · Keycloak is not live (simulation / no admin password) — nothing to clear.');
    console.log('    The DB mirror wipe above is sufficient when Keycloak is in simulation.');
  } else {
    try {
      const allRoles = await keycloakAdminService.listRealmRoles();
      // Scoped admin roles carry a trailing "_<platform>[_<slug>]". The bare
      // markers ("hermes_platform_admin" / "hermes_group_admin") have no trailing
      // underscore, and "hermes_super_admin" matches neither prefix — so all three
      // are excluded and survive the reset.
      const scopedAdminRoles = allRoles.filter(
        (r) =>
          r.name.startsWith('hermes_platform_admin_') ||
          r.name.startsWith('hermes_group_admin_'),
      );

      if (scopedAdminRoles.length === 0) {
        console.log('  · No scoped Hermes admin roles found in Keycloak.');
      } else {
        const affectedUserIds = new Set<string>();
        for (const role of scopedAdminRoles) {
          try {
            // Collect holders *before* deleting so we can log them out afterward.
            for (const userId of await keycloakAdminService.getUsersInRole(role.name)) {
              affectedUserIds.add(userId);
            }
            await keycloakAdminService.deleteRealmRole(role.name);
            console.log(`  ✓ removed role ${role.name}`);
          } catch (err: any) {
            console.log(`  ✗ failed to remove role ${role.name}: ${err.message} (continuing)`);
          }
        }
        // Terminate sessions so the just-removed roles leave users' JWTs now
        // rather than lingering until token expiry. Best-effort — never throws.
        for (const userId of affectedUserIds) {
          await keycloakAdminService.logoutUser(userId);
        }
        console.log(
          `  ✓ Cleared ${scopedAdminRoles.length} scoped admin role(s); logged out ${affectedUserIds.size} affected user(s).`,
        );
        console.log('    (hermes_super_admin and the bare markers were left untouched.)');
      }
    } catch (err: any) {
      console.log(`  ✗ Keycloak admin-role cleanup failed: ${err.message}`);
      console.log('    Continuing — remove the stale scoped roles via the Keycloak admin UI if needed.');
    }
  }
  console.log('');

  // ── 3. Re-map Hermes Group.externalGroupId by name ──────────────────
  console.log('Step 3/3 — Remapping Hermes Group.externalGroupId to live Redash IDs…');
  // Only Redash groups. `Group.platform` is now required and multi-platform, so
  // a name collision with a future AWS/Jira group must not get a Redash ID
  // written into its externalGroupId (which would route provisioning wrong).
  const hermesGroups = await prisma.group.findMany({
    where: { platform: 'redash' },
    orderBy: { name: 'asc' },
  });
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
