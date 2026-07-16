import { z } from 'zod';

export const auditQuerySchema = z
  .object({
    action: z.string().max(100).optional(),
    search: z.string().max(200).optional(),
    // The performer (actor) of the entry — exact Keycloak user id match.
    performerId: z.string().max(200).optional(),
    // Restrict to a single group. UUID so a malformed value fails fast.
    groupId: z.string().uuid('Invalid Group ID').optional(),
    // Platform key (e.g. "redash", "aws"). AuditEntry has no platform column, so the
    // controller resolves this to the group ids on that platform — entries with a
    // null groupId (e.g. MANUAL_SYNC_TRIGGERED) won't match a platform filter.
    platform: z.string().max(100).optional(),
    // Inclusive date bounds. Accept either a date-only string ("2026-06-01", as
    // produced by <input type="date">) or a full ISO timestamp; the controller
    // expands a date-only `toDate` to end-of-day. Parsing/validity is checked there.
    fromDate: z.string().max(40).optional(),
    toDate: z.string().max(40).optional(),
  })
  // Ignore empty-string query params (the frontend sends "" for an unset filter)
  // so they don't get treated as real values downstream.
  .transform((q) => {
    const cleaned: typeof q = { ...q };
    (Object.keys(cleaned) as (keyof typeof q)[]).forEach((k) => {
      if (cleaned[k] === '') {cleaned[k] = undefined;}
    });
    return cleaned;
  });
