import logger from './logger';
import config from '../config/config';

/**
 * Rewrite a Redash-issued invite link so its protocol + host + port match the
 * configured `REDASH_BASE_URL`.
 *
 * Why: Redash sometimes hands back invite URLs whose host/port doesn't match
 * the URL Hermes was configured to talk to (e.g. an internal docker hostname,
 * or the originating request's port — at one point we saw `:5173`, the Vite
 * dev server). Clicking those links is broken for the user. We normalize on
 * the way out so the link we surface always points at the Redash UI Hermes
 * itself uses.
 *
 * Rules:
 *  - Empty / null / undefined → returned unchanged.
 *  - Relative (`/invite/<token>`) → prefixed with `REDASH_BASE_URL`.
 *  - Absolute → its protocol + host (which includes port) are overridden to
 *    match `REDASH_BASE_URL`; path + query + fragment are preserved.
 *
 * Safe: any URL parse failure is logged at warn level and the original string
 * is returned. Callers don't need their own try/catch.
 */
export function normalizeRedashInviteLink<T extends string | null | undefined>(link: T): T {
  if (!link) return link;
  try {
    if (link.startsWith('/')) {
      const base = config.redash.baseUrl.replace(/\/$/, '');
      return (`${base}${link}`) as T;
    }
    const parsedUrl = new URL(link);
    const configuredUrl = new URL(config.redash.baseUrl);
    parsedUrl.protocol = configuredUrl.protocol;
    parsedUrl.host = configuredUrl.host;
    return parsedUrl.toString() as T;
  } catch (err: any) {
    logger.warn(
      { inviteLink: link, error: err.message },
      'Failed to normalize Redash invite link; returning original',
    );
    return link;
  }
}

export default normalizeRedashInviteLink;
