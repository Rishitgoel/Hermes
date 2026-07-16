import { z } from 'zod';

// A permission-level (subgroup) inside a Group. `externalGroupId` maps the level
// to its backing platform group (e.g. a Redash group id) — platform configuration,
// so only super/platform admins set it (enforced in the controller). For ZooKeeper it
// may be a newline-separated list of znode paths (hence the generous cap), and editing
// it reconciles the level's existing members onto the new mapping.
export const createGroupLevelSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must not exceed 100 characters'),
  slug: z
    .string()
    .trim()
    .min(1, 'Slug is required')
    .max(100, 'Slug must not exceed 100 characters')
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z
    .string()
    .trim()
    .max(1000, 'Description must not exceed 1000 characters')
    .optional(),
  permission: z
    .string()
    .trim()
    .max(100, 'Permission label must not exceed 100 characters')
    .optional(),
  externalGroupId: z.string().trim().min(1).max(4000).optional(),
  rank: z
    .number()
    .int()
    .min(0, 'Rank must be a non-negative integer')
    .optional(),
  isActive: z.boolean().optional(),
});

export const updateGroupLevelSchema = createGroupLevelSchema.partial();
