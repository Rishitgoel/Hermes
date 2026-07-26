import Keycloak from 'keycloak-js';

/**
 * Keycloak client singleton.
 *
 * Every field is read from the environment so a local checkout points at a local
 * Keycloak. Hardcoding the URL here (as the admin-panel copy of this file does,
 * because it only ever runs against one realm) silently sends `npm run dev` to
 * the production login screen — the .env values below exist precisely so it
 * doesn't. The fallbacks are the production values, for builds that ship without
 * a .env.
 */
const keycloak: Keycloak = new Keycloak({
  url: import.meta.env.VITE_KEYCLOAK_URL || 'https://keycloak.bachatt.app',
  realm: import.meta.env.VITE_KEYCLOAK_REALM || 'master',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'hermes-prod',
});

export default keycloak;
