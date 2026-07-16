import { z } from 'zod';

// A single staged change. Path-scope / writable authorization is DB-state dependent and
// lives in the service (zookeeper-config.service), not here — exactly like access-request
// level requiredness. This schema only enforces shape and bounds.
const zkChangeSchema = z.object({
  path: z
    .string()
    .trim()
    .regex(/^\/.+/, 'Path must start with "/"')
    .max(512, 'Path is too long'),
  action: z.enum(['SET', 'CREATE', 'DELETE', 'CLEAR'], {
    errorMap: () => ({
      message: 'action must be SET, CREATE, DELETE or CLEAR',
    }),
  }),
  oldValue: z.string().max(50000, 'Value is too large').nullish(),
  newValue: z.string().max(50000, 'Value is too large').nullish(),
});

// No groupId — the owning group of each change is resolved server-side from the user's
// grants (a request may span several groups; it's routed to all involved admins).
export const submitZkChangeSchema = z.object({
  justification: z
    .string()
    .trim()
    .max(1000, 'Justification must not exceed 1000 characters')
    .optional(),
  changes: z
    .array(zkChangeSchema)
    .min(1, 'At least one change is required')
    .max(200, 'Cannot submit more than 200 changes at once')
    // Review decisions are keyed by path — the same (path, action) twice would share
    // one decision and apply twice, so reject it. Different actions on one path stay
    // allowed (e.g. CREATE followed by SET is a legitimate staged sequence).
    .refine(
      changes =>
        new Set(changes.map(c => `${c.action} ${c.path}`)).size ===
        changes.length,
      'Duplicate changes (same path and action) are not allowed in a single request',
    ),
});

// Per-change decisions (git-style): each change is approved or rejected independently.
export const reviewZkChangeSchema = z.object({
  decisions: z
    .array(
      z.object({
        path: z.string().regex(/^\/.+/, 'Path must start with "/"'),
        decision: z.enum(['APPROVED', 'REJECTED'], {
          errorMap: () => ({
            message: 'decision must be APPROVED or REJECTED',
          }),
        }),
      }),
    )
    .min(1, 'At least one decision is required')
    .max(200, 'Too many decisions'),
  note: z
    .string()
    .max(250, 'Review notes must not exceed 250 characters')
    .optional(),
});
