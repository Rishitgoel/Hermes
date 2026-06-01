/**
 * One-shot migration: legacy group-admin roles → platform-qualified roles.
 *
 * Converts Keycloak realm roles of the legacy form
 *     hermes_group_admin_<slug>        (e.g. hermes_group_admin_growth)
 * to the new, platform-qualified form
 *     hermes_group_admin_<platform>_<slug>  (e.g. hermes_group_admin_redash_growth)
 *
 * For each legacy role whose slug maps to a known Hermes group:
 *   1. Ensure the new composite role exists (includes the hermes_group_admin marker).
 *   2. Re-map every user from the legacy role to the new role.
 *   3. Upsert the GroupAdmin DB mirror row for each user (so the mirror is authoritative).
 *   4. Delete the legacy role.
 *
 * Legacy roles whose slug doesn't match any group are LEFT ALONE (logged), since
 * we can't infer their platform.
 *
 * Usage (from backend/):
 *   npx ts-node scripts/migrate-group-admin-roles.ts
 *
 * Requires live Keycloak (KEYCLOAK_SIMULATION=false + KEYCLOAK_ADMIN_PASSWORD).
 * Idempotent and safe to re-run.
 */

import prisma from '../src/config/prisma';
import config from '../src/config/config';
import keycloakAdminService from '../src/services/keycloak-admin.service';
import provisioningRegistry from '../src/services/provisioning.registry';

const GROUP_ADMIN_MARKER = 'hermes_group_admin';
const LEGACY_PREFIX = 'hermes_group_admin_';
const groupAdminRole = (platform: string, slug: string) =>
  `hermes_group_admin_${platform.toLowerCase()}_${slug.toLowerCase()}`;

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Hermes: migrate group-admin roles → platform-qualified');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!keycloakAdminService.isLive) {
    console.error(
      'Keycloak is not live (simulation mode or missing KEYCLOAK_ADMIN_PASSWORD). Nothing to migrate.',
    );
    process.exit(1);
  }

  const platforms = provisioningRegistry.listPlatforms().map((p) => p.toLowerCase());
  console.log(`  Realm:      ${config.keycloak.realm}`);
  console.log(`  Platforms:  ${platforms.join(', ')}`);

  const allRoles = await keycloakAdminService.listRealmRoles();

  // Legacy = starts with the group-admin prefix, is not the bare marker, and is
  // NOT already platform-qualified (doesn't begin with a known platform key).
  const legacyRoles = allRoles.filter((r) => {
    const name = r.name.toLowerCase();
    if (!name.startsWith(LEGACY_PREFIX)) return false;
    if (name === GROUP_ADMIN_MARKER) return false;
    const rest = name.substring(LEGACY_PREFIX.length);
    const isQualified = platforms.some((p) => rest.startsWith(`${p}_`));
    return !isQualified;
  });

  if (legacyRoles.length === 0) {
    console.log('  No legacy group-admin roles found. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  console.log(`  Found ${legacyRoles.length} legacy role(s): ${legacyRoles.map((r) => r.name).join(', ')}`);
  console.log('');

  let migrated = 0;
  let skipped = 0;

  for (const role of legacyRoles) {
    const slugPart = role.name.substring(LEGACY_PREFIX.length);
    const slug = slugPart.replace(/_/g, '-'); // legacy encoded hyphens as underscores

    const group = await prisma.group.findUnique({ where: { slug } });
    if (!group) {
      console.log(`  ⚠ SKIP "${role.name}" — no group with slug "${slug}" (can't infer platform).`);
      skipped += 1;
      continue;
    }

    const newRole = groupAdminRole(group.platform, group.slug);
    console.log(`  → "${role.name}"  ⇒  "${newRole}"  (group: ${group.name}, platform: ${group.platform})`);

    await keycloakAdminService.ensureCompositeRole(
      newRole,
      GROUP_ADMIN_MARKER,
      `Hermes group admin for ${group.platform}/${group.slug}`,
    );

    const userIds = await keycloakAdminService.getUsersInRole(role.name);
    console.log(`     ${userIds.length} user(s) to re-map`);

    for (const userId of userIds) {
      // Assign new role.
      await keycloakAdminService.assignRealmRole(userId, newRole);

      // Resolve a name/email for the mirror row (prefer what Hermes already has).
      const seen = await prisma.userCreationRequest.findUnique({
        where: { userId },
        select: { userName: true, userEmail: true },
      });
      let userName = seen?.userName;
      let userEmail = seen?.userEmail;
      if (!userName || !userEmail) {
        const kcUser = await keycloakAdminService.getUser(userId);
        userName = userName || kcUser?.username || userId;
        userEmail = userEmail || kcUser?.email || '';
      }

      // Upsert the DB mirror so authorization/listing works without the role parse.
      await prisma.groupAdmin.upsert({
        where: { groupId_userId: { groupId: group.id, userId } },
        update: { userName, userEmail, assignedBy: 'migration' },
        create: { groupId: group.id, userId, userName, userEmail, assignedBy: 'migration' },
      });

      // Remove the legacy role from the user.
      await keycloakAdminService.removeRealmRole(userId, role.name);
      console.log(`     ✔ ${userName} (${userId})`);
    }

    // Finally delete the now-unused legacy role.
    await keycloakAdminService.deleteRealmRole(role.name);
    console.log(`     ✔ deleted legacy role "${role.name}"`);
    migrated += 1;
  }

  console.log('');
  console.log(`  Done. Migrated ${migrated} role(s), skipped ${skipped}.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
