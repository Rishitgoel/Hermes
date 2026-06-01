/**
 * One-shot: re-run Keycloak client/role setup against the live realm. Idempotent.
 *
 * Use after changing role definitions (e.g. the clarified marker descriptions) so
 * existing roles pick up the new text without waiting for the next backend boot.
 * It runs the exact same `ensureClientAndRolesExist()` the server runs on startup.
 *
 * Usage (from backend/):
 *   npx ts-node scripts/sync-keycloak-roles.ts
 *
 * Requires live Keycloak (KEYCLOAK_SIMULATION=false + KEYCLOAK_ADMIN_PASSWORD).
 */

import keycloakSetupService from '../src/config/keycloak-setup';
import config from '../src/config/config';

async function main() {
  if (config.isSimulation || !config.keycloak.adminPassword) {
    console.error('Keycloak is not live (simulation mode or missing admin password). Nothing to sync.');
    process.exit(1);
  }
  console.log(`Syncing Keycloak client + roles for realm "${config.keycloak.realm}"…`);
  await keycloakSetupService.ensureClientAndRolesExist();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
