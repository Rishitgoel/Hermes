import { z } from 'zod';

const entrySchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, 'Key name cannot be empty')
    .max(512, 'Key name is too long'),
  value: z.string().max(50000, 'Value is too large'),
});

// A manifest file the requester chose to include in the infra-deployment PR.
const selectedTargetSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, 'File path cannot be empty')
    .max(400, 'File path is too long'),
  manifestRef: z.string().trim().max(512).optional(),
  format: z.enum(['helm-values', 'spc']).optional(),
  // Exact keys the requester wants applied to THIS file — a subset of what the scan found
  // missing there. Omitted/empty = apply every key (today's default).
  keys: z.array(z.string().trim().min(1).max(512)).max(200).optional(),
  // The env this path resolved to at compose time — carried through so the reviewer sees the
  // same env label the requester did, not a re-derived guess. Purely informational.
  env: z.string().trim().max(64).optional(),
});

// Which Secret Ingestion instance (AWS account) the request targets, e.g. "secrets" or
// "secrets-sandbox". Optional (defaults to prod); validated against the configured secrets
// family in the controller/service, not here.
const platformSchema = z.string().trim().min(1).max(64).optional();

export const submitIngestionSchema = z.object({
  platform: platformSchema,
  secretName: z
    .string()
    .trim()
    .min(1, 'Secret name cannot be empty')
    .max(512, 'Secret name is too long'),
  justification: z
    .string()
    .trim()
    .max(1000, 'Justification must not exceed 1000 characters')
    .optional(),
  entries: z
    .array(entrySchema)
    .min(1, 'At least one entry is required')
    .max(200, 'Cannot submit more than 200 entries at once')
    // Review decisions are keyed by key name — duplicates would share one decision
    // and silently last-write-win on apply, so reject them up front.
    .refine(
      entries => new Set(entries.map(e => e.key)).size === entries.length,
      'Duplicate keys are not allowed in a single request',
    ),
  // The requester's chosen infra-deployment manifest files (from the compose preview).
  // Omitted ⇒ the PR falls back to the live auto-resolved consumer set.
  infraTargets: z
    .array(selectedTargetSchema)
    .max(50, 'Too many target files')
    .optional(),
});

// Compose-screen preview: which manifests would change for a secret + a set of keys.
export const infraPreviewSchema = z.object({
  platform: platformSchema,
  secretName: z
    .string()
    .trim()
    .min(1, 'Secret name cannot be empty')
    .max(512, 'Secret name is too long'),
  keys: z
    .array(z.string().trim().min(1, 'Key name cannot be empty').max(512))
    .min(1, 'At least one key is required')
    .max(200, 'Too many keys'),
});

// Solve drift: open a draft infra-deployment PR registering the AWS keys missing from the
// manifests for one secret. Platform is validated against the secrets family in the controller.
export const resolveDriftSchema = z.object({
  platform: platformSchema,
  secretName: z
    .string()
    .trim()
    .min(1, 'Secret name cannot be empty')
    .max(512, 'Secret name is too long'),
});

// Ignore/unignore one missingInAws (dangling) drift key so it stops counting toward scheduled
// drift notifications.
export const driftKeySchema = resolveDriftSchema.extend({
  key: z
    .string()
    .trim()
    .min(1, 'Key cannot be empty')
    .max(512, 'Key is too long'),
});

export const reviewIngestionSchema = z.object({
  decisions: z
    .array(
      z.object({
        key: z.string().min(1, 'Key name cannot be empty'),
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
