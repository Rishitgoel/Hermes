import { z } from 'zod';

export const groupSlugSchema = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens');
export const groupIdSchema = z.string().uuid('Invalid Group ID format');

// ── Group CRUD (super / platform admin only — enforced in the controller) ─────
// A Group is the unit a user requests access to; it belongs to exactly one
// platform (the adapter that provisions it). `externalGroupId` maps the group to
// its backing platform group — leave it blank on create and Hermes provisions one
// via the platform adapter (the same path level CRUD uses).
export const createGroupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name must not exceed 100 characters'),
  slug: z
    .string()
    .trim()
    .min(1, 'Slug is required')
    .max(100, 'Slug must not exceed 100 characters')
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  // Optional — the create form no longer requires a description. Defaults to an
  // empty string so the non-nullable column always gets a value (no migration).
  description: z
    .string()
    .trim()
    .max(1000, 'Description must not exceed 1000 characters')
    .optional()
    .default(''),
  // Stored lowercase; the controller validates it against the provisioning registry.
  platform: z.string().trim().min(1, 'Platform is required').max(50).toLowerCase(),
  icon: z.string().trim().max(100).optional(),
  color: z.string().trim().max(50).optional(),
  tables: z.array(z.string().trim().min(1)).max(200).optional(),
  // A single backing-group id, OR (ZooKeeper) a newline-separated list of znode paths,
  // hence the generous cap. The controller validates the value against the adapter.
  externalGroupId: z.string().trim().min(1).max(4000).optional(),
});

// Edit only the safe fields. slug / platform stay immutable: changing slug or platform
// would break group-admin role names (hermes_group_admin_<platform>_<slug>) and reroute
// the adapter. externalGroupId is editable ONLY for platforms whose adapter can
// reconcile existing members onto the new mapping (ZooKeeper's multi-path list); the
// controller rejects the edit for single-group platforms (Redash/AWS), where a swap
// would orphan members. isActive drives archive/restore.
export const updateGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    // Allow clearing the description (empty string), since it's optional on create.
    description: z.string().trim().max(1000).optional(),
    icon: z.string().trim().max(100).nullable().optional(),
    color: z.string().trim().max(50).nullable().optional(),
    tables: z.array(z.string().trim().min(1)).max(200).optional(),
    externalGroupId: z.string().trim().min(1).max(4000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' });
