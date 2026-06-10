/** Shared formatting helpers for the Admin Management components. */

export const prettyPlatform = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

/** Keycloak usernames can carry underscores; render them as spaces. */
export const cleanName = (n: string) => n.replace(/_/g, ' ');

export const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
