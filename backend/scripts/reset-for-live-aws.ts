/**
 * One-shot reset for exercising Hermes against a real AWS IAM Identity Center
 * (Identity Store) from a clean slate — the AWS analogue of
 * {@link ./reset-for-live-redash.ts}.
 *
 * What it does:
 *  1. Smoke-tests the live AWS connection (health check + ListGroups) BEFORE
 *     deleting anything. Aborts if AWS is unreachable or still in simulation.
 *  2. Cleans the live Identity Store while KEEPING the 6 managed "AWS - …" groups:
 *       • clears every membership from those 6 groups (access grants → zero), and
 *       • deletes the leftover provisioned users — EXCEPT every member of the
 *         `API-TESTING` group.
 *     ⚠ `API-TESTING` + its member `Api_TESTER` are LOAD-BEARING: the AWS profile
 *     this whole integration runs as (APIAdministratorAccess) reaches its
 *     AdministratorAccess permission set *through* the `API-TESTING` group. Delete
 *     that group/user/membership and you revoke the admin rights every AWS call
 *     (including this script's) depends on. So they are never touched, and the
 *     script HARD-ABORTS user deletion if it can't positively identify the
 *     `API-TESTING` members to protect.
 *  3. Wipes Hermes transient state. Platform-scoped to `aws` (access requests,
 *     grants, user-creation requests, group/platform admin mirrors, and the `aws`
 *     PlatformExternalUser/Group cache) so a Redash reset isn't undone — except
 *     notifications + audit_entries, which have no platform key and are cleared
 *     globally (same as the Redash reset; they're just history).
 *  4. Clears the Hermes-managed `aws` scoped admin roles from Keycloak
 *     (hermes_platform_admin_aws / hermes_group_admin_aws_*) and logs the affected
 *     users out, so a wiped DB mirror isn't reconciled straight back from a
 *     lingering Keycloak role. Redash/super-admin roles + the bare markers are left
 *     untouched. No-op when Keycloak isn't live.
 *  5. Keeps the Hermes Group & GroupLevel rows (descriptions, icons, tables) but
 *     re-maps each `aws` Group.externalGroupId / GroupLevel.externalGroupId to the
 *     matching live Identity Store GroupId by display-name lookup (self-healing;
 *     usually a confirm/no-op).
 *
 * Usage (from backend/):
 *   npx ts-node scripts/reset-for-live-aws.ts              # DRY RUN — prints the plan, mutates nothing
 *   npx ts-node scripts/reset-for-live-aws.ts --execute    # actually performs the reset
 *
 * Defaults to a dry run because step 2 deletes real Identity Store users. Safe to
 * re-run. Will NOT delete the 6 managed groups, the API-TESTING group, or any
 * Group / GroupLevel business config beyond externalGroupId.
 */

import dotenv from 'dotenv';
import path from 'path';

// Load backend/.env explicitly (matches the sibling AWS scripts) so the SDK's
// default credential chain can see AWS_PROFILE / AWS_REGION before any client is
// built — even if this is ever run from a different cwd.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { IdentitystoreClient, DeleteUserCommand } from '@aws-sdk/client-identitystore';
import prisma from '../src/config/prisma';
import config from '../src/config/config';
import awsIdentityCenterService, { IdcGroup, IdcUser } from '../src/services/aws-identity-center.service';
import keycloakAdminService from '../src/services/keycloak-admin.service';

const PLATFORM = 'aws';
const API_TESTING_GROUP_NAME = 'API-TESTING';

// Dry run unless explicitly told to execute. Deleting live AWS users is
// irreversible, so make "do nothing destructive" the default.
const EXECUTE = process.argv.includes('--execute');
const DRY = !EXECUTE;

/** Build an Identity Store client the same way the service does (default cred chain). */
function buildIdcClient(): IdentitystoreClient {
  const region = config.aws.identityCenterRegion;
  if (!region) throw new Error('AWS region for Identity Center is not configured');
  const accessKeyId = config.aws.accessKeyId;
  const secretAccessKey = config.aws.secretAccessKey;
  return new IdentitystoreClient({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Hermes reset → live AWS IAM Identity Center  ${DRY ? '(DRY RUN)' : '(EXECUTE)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Identity Store: ${config.aws.identityStoreId}`);
  console.log(`  Region:         ${config.aws.identityCenterRegion}`);
  console.log(`  Simulation:     ${config.aws.isSimulation ? 'SIM' : 'LIVE'}`);
  if (DRY) console.log('  Mode:           DRY RUN — nothing will be changed. Re-run with --execute to apply.');
  console.log('');

  if (config.aws.isSimulation) {
    console.error(
      '✗ Refusing to run: AWS is in simulation mode (AWS_SIMULATION=true or no AWS_IDENTITY_STORE_ID).\n' +
        '  The simulation store is in-process and ephemeral — just restart the backend to reset it.\n' +
        '  To reset a real Identity Store, set AWS_SIMULATION=false + AWS_IDENTITY_STORE_ID + region/creds.',
    );
    process.exit(1);
  }

  // ── 1. Smoke-test live AWS BEFORE deleting anything ──────────────────────────
  console.log('Step 1/5 — Verifying live AWS connection…');
  const health = await awsIdentityCenterService.healthCheck();
  if (!health.healthy) {
    console.error(`✗ AWS Identity Center is not reachable: ${health.message}`);
    console.error('  Nothing was changed. Run "aws sso login" if your session expired, then retry.');
    process.exit(1);
  }
  let liveGroups: IdcGroup[];
  let liveUsers: IdcUser[];
  try {
    liveGroups = await awsIdentityCenterService.listGroups();
    liveUsers = await awsIdentityCenterService.listUsers(); // each user carries groupIds
  } catch (err: any) {
    console.error(`✗ Could not read the Identity Store: ${err?.message || err}`);
    console.error('  Nothing was changed.');
    process.exit(1);
  }
  console.log(`  ✓ Connected. ${liveGroups.length} live group(s), ${liveUsers.length} live user(s):`);
  for (const g of liveGroups) console.log(`     [group] ${g.displayName}  (${g.groupId})`);
  for (const u of liveUsers) console.log(`     [user]  ${u.userName}  (${u.userId})  groups=${u.groupIds.length}`);
  console.log('');

  // Identify the 6 managed groups (by matching the Hermes `aws` Group names) and
  // the load-bearing API-TESTING group + its members (the admin principal).
  const hermesAwsGroups = await prisma.group.findMany({ where: { platform: PLATFORM } });
  const hermesNames = new Set(hermesAwsGroups.map(g => g.name.trim().toLowerCase()));
  const managedLiveGroups = liveGroups.filter(g => hermesNames.has(g.displayName.trim().toLowerCase()));
  const managedGroupIds = new Set(managedLiveGroups.map(g => g.groupId));

  const apiTestingGroup = liveGroups.find(
    g => g.displayName.trim().toUpperCase() === API_TESTING_GROUP_NAME,
  );
  const keepUserIds = new Set(
    apiTestingGroup ? liveUsers.filter(u => u.groupIds.includes(apiTestingGroup.groupId)).map(u => u.userId) : [],
  );

  console.log(`  Managed groups to KEEP (${managedLiveGroups.length}): ${managedLiveGroups.map(g => g.displayName).join(', ') || '(none matched!)'}`);
  console.log(
    `  Protected admin principal(s): ${
      keepUserIds.size
        ? [...keepUserIds].map(id => liveUsers.find(u => u.userId === id)?.userName ?? id).join(', ')
        : '(none — API-TESTING not found!)'
    }`,
  );
  console.log('');

  // ── 2. Clean the live Identity Store (keep the 6 groups + API-TESTING) ───────
  console.log(`Step 2/5 — Cleaning live Identity Store…`);

  // 2a. Clear memberships from the 6 managed groups → access grants reset to zero.
  let membershipsCleared = 0;
  for (const u of liveUsers) {
    for (const gid of u.groupIds) {
      if (!managedGroupIds.has(gid)) continue;
      const gName = managedLiveGroups.find(g => g.groupId === gid)?.displayName ?? gid;
      if (DRY) {
        console.log(`  · would remove ${u.userName} from ${gName}`);
      } else {
        await awsIdentityCenterService.removeUserFromGroup(gid, u.userId);
        console.log(`  ✓ removed ${u.userName} from ${gName}`);
      }
      membershipsCleared++;
    }
  }
  if (membershipsCleared === 0) console.log('  · no memberships in the managed groups (already clean).');

  // 2b. Delete leftover provisioned users — but NEVER an API-TESTING member, and
  // ONLY if we could positively identify that protected set (else hard-abort, so a
  // lookup failure can't make us delete the admin principal the integration runs as).
  console.log('');
  if (!apiTestingGroup || keepUserIds.size === 0) {
    console.log(
      `  ⚠ SKIPPING user deletion: could not resolve the "${API_TESTING_GROUP_NAME}" group / its members.`,
    );
    console.log('    Refusing to delete any user without knowing which one holds the admin permission set.');
  } else {
    const client = DRY ? null : buildIdcClient();
    const identityStoreId = config.aws.identityStoreId!;
    let deleted = 0;
    for (const u of liveUsers) {
      if (keepUserIds.has(u.userId)) {
        console.log(`  · keeping ${u.userName} (holds admin permission set via ${API_TESTING_GROUP_NAME})`);
        continue;
      }
      if (DRY) {
        console.log(`  · would DELETE user ${u.userName} (${u.userId})`);
      } else {
        try {
          await client!.send(new DeleteUserCommand({ IdentityStoreId: identityStoreId, UserId: u.userId }));
          console.log(`  ✓ deleted user ${u.userName} (${u.userId})`);
          deleted++;
        } catch (err: any) {
          console.log(`  ✗ failed to delete ${u.userName}: ${err?.message || err} (continuing)`);
        }
      }
    }
    if (!DRY) console.log(`  ✓ Deleted ${deleted} user(s); kept ${keepUserIds.size} protected, ${managedLiveGroups.length} managed groups.`);
  }
  console.log('');

  // ── 3. Wipe Hermes transient state (aws-scoped; logs global) ─────────────────
  console.log('Step 3/5 — Wiping Hermes transient state…');
  // notifications + audit_entries have no platform column → cleared globally (same
  // as the Redash reset). Deleting audit_entries first also clears their FK refs to
  // access_requests. Everything else is scoped to platform 'aws' so a Redash reset
  // isn't undone.
  const wipes: Array<[string, () => Promise<number>, () => Promise<{ count: number }>]> = [
    ['notifications (global)', () => prisma.notification.count(), () => prisma.notification.deleteMany({})],
    ['audit_entries (global)', () => prisma.auditEntry.count(), () => prisma.auditEntry.deleteMany({})],
    ['user_accesses (aws)', () => prisma.userAccess.count({ where: { group: { platform: PLATFORM } } }), () => prisma.userAccess.deleteMany({ where: { group: { platform: PLATFORM } } })],
    ['access_requests (aws)', () => prisma.accessRequest.count({ where: { group: { platform: PLATFORM } } }), () => prisma.accessRequest.deleteMany({ where: { group: { platform: PLATFORM } } })],
    ['user_creation_requests (aws)', () => prisma.userCreationRequest.count({ where: { platform: PLATFORM } }), () => prisma.userCreationRequest.deleteMany({ where: { platform: PLATFORM } })],
    ['group_admins (aws)', () => prisma.groupAdmin.count({ where: { group: { platform: PLATFORM } } }), () => prisma.groupAdmin.deleteMany({ where: { group: { platform: PLATFORM } } })],
    ['platform_admins (aws)', () => prisma.platformAdmin.count({ where: { platform: PLATFORM } }), () => prisma.platformAdmin.deleteMany({ where: { platform: PLATFORM } })],
    ['platform_external_users (aws)', () => prisma.platformExternalUser.count({ where: { platform: PLATFORM } }), () => prisma.platformExternalUser.deleteMany({ where: { platform: PLATFORM } })],
    ['platform_external_groups (aws)', () => prisma.platformExternalGroup.count({ where: { platform: PLATFORM } }), () => prisma.platformExternalGroup.deleteMany({ where: { platform: PLATFORM } })],
  ];
  for (const [label, countFn, delFn] of wipes) {
    if (DRY) {
      console.log(`  · would delete ${label.padEnd(30, ' ')} ${await countFn()}`);
    } else {
      const r = await delFn();
      console.log(`  ✓ ${label.padEnd(30, ' ')} deleted ${r.count}`);
    }
  }
  console.log('');

  // ── 4. Clear Hermes-managed `aws` scoped admin roles from Keycloak ───────────
  console.log('Step 4/5 — Clearing aws-scoped admin roles from Keycloak…');
  if (!keycloakAdminService.isLive) {
    console.log('  · Keycloak is not live (simulation / no admin password) — nothing to clear.');
  } else {
    try {
      const allRoles = await keycloakAdminService.listRealmRoles();
      // Only aws scoped roles: `hermes_platform_admin_aws` and `hermes_group_admin_aws_<slug>`.
      // The bare markers (hermes_platform_admin / hermes_group_admin), hermes_super_admin,
      // and every redash-scoped role are excluded — so a Redash reset isn't undone.
      const scopedAwsRoles = allRoles.filter(
        r =>
          (r.name || '').startsWith('hermes_platform_admin_aws') ||
          (r.name || '').startsWith('hermes_group_admin_aws_'),
      );
      if (scopedAwsRoles.length === 0) {
        console.log('  · No aws-scoped Hermes admin roles found in Keycloak.');
      } else if (DRY) {
        for (const role of scopedAwsRoles) console.log(`  · would remove role ${role.name}`);
      } else {
        const affectedUserIds = new Set<string>();
        for (const role of scopedAwsRoles) {
          try {
            for (const userId of await keycloakAdminService.getUsersInRole(role.name!)) affectedUserIds.add(userId);
            await keycloakAdminService.deleteRealmRole(role.name!);
            console.log(`  ✓ removed role ${role.name}`);
          } catch (err: any) {
            console.log(`  ✗ failed to remove role ${role.name}: ${err.message} (continuing)`);
          }
        }
        for (const userId of affectedUserIds) await keycloakAdminService.logoutUser(userId);
        console.log(`  ✓ Cleared ${scopedAwsRoles.length} aws scoped role(s); logged out ${affectedUserIds.size} user(s).`);
      }
    } catch (err: any) {
      console.log(`  ✗ Keycloak admin-role cleanup failed: ${err.message} (continuing)`);
    }
  }
  console.log('');

  // ── 5. Re-map Hermes `aws` Group & GroupLevel externalGroupIds ───────────────
  console.log('Step 5/5 — Remapping Hermes aws Group & GroupLevel externalGroupIds to live Identity Store IDs…');
  const byName = new Map(liveGroups.map(g => [g.displayName.trim().toLowerCase(), g]));

  const sortedGroups = [...hermesAwsGroups].sort((a, b) => a.name.localeCompare(b.name));
  let mapped = 0;
  const unmapped: string[] = [];
  for (const hg of sortedGroups) {
    const match = byName.get(hg.name.trim().toLowerCase());
    if (!match) {
      unmapped.push(hg.name);
      console.log(`  ✗ ${hg.name.padEnd(24, ' ')} no matching Identity Store group (skipped)`);
      continue;
    }
    if (hg.externalGroupId === match.groupId) {
      console.log(`  · ${hg.name.padEnd(24, ' ')} already mapped → ${match.groupId}`);
      continue;
    }
    if (!DRY) await prisma.group.update({ where: { id: hg.id }, data: { externalGroupId: match.groupId } });
    console.log(`  ${DRY ? '·' : '✓'} ${hg.name.padEnd(24, ' ')} ${hg.externalGroupId ?? '(null)'} → ${match.groupId}${DRY ? '  (would map)' : ''}`);
    mapped++;
  }
  console.log(`  ${DRY ? 'Would map' : 'Mapped'} ${mapped} group(s). Unmapped: ${unmapped.length ? unmapped.join(', ') : 'none'}`);

  const awsLevels = await prisma.groupLevel.findMany({ where: { group: { platform: PLATFORM } }, include: { group: true } });
  if (awsLevels.length) {
    console.log('');
    console.log('  Remapping aws GroupLevel externalGroupIds…');
    let mappedLevels = 0;
    for (const hl of awsLevels) {
      const fullName = `${hl.group.name} — ${hl.name}`;
      const match = byName.get(fullName.trim().toLowerCase());
      if (!match || hl.externalGroupId === match.groupId) {
        console.log(`  · ${fullName.padEnd(30, ' ')} ${match ? 'already mapped' : 'no matching Identity Store group'}`);
        continue;
      }
      if (!DRY) await prisma.groupLevel.update({ where: { id: hl.id }, data: { externalGroupId: match.groupId } });
      console.log(`  ${DRY ? '·' : '✓'} ${fullName.padEnd(30, ' ')} → ${match.groupId}`);
      mappedLevels++;
    }
    console.log(`  ${DRY ? 'Would map' : 'Mapped'} ${mappedLevels} level(s).`);
  } else {
    console.log('  (no aws GroupLevels to remap)');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (DRY) {
    console.log('  DRY RUN complete — nothing was changed.');
    console.log('  Re-run with --execute to apply:  npx ts-node scripts/reset-for-live-aws.ts --execute');
  } else {
    console.log('  Done. The 6 managed groups + API-TESTING were preserved.');
    console.log('  Restart the backend (`npm run dev`) to trigger the initial live sync.');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch(err => {
    console.error('Reset failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
