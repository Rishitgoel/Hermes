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
  description: z
    .string()
    .trim()
    .min(1, 'Description is required')
    .max(1000, 'Description must not exceed 1000 characters'),
  // Stored lowercase; the controller validates it against the provisioning registry.
  platform: z.string().trim().min(1, 'Platform is required').max(50).toLowerCase(),
  icon: z.string().trim().max(100).optional(),
  color: z.string().trim().max(50).optional(),
  tables: z.array(z.string().trim().min(1)).max(200).optional(),
  externalGroupId: z.string().trim().min(1).max(255).optional(),
});

// Edit only the safe, presentational fields. slug / platform / externalGroupId are
// intentionally omitted: changing slug or platform would break group-admin role
// names (hermes_group_admin_<platform>_<slug>) and reroute the adapter, and changing
// the base externalGroupId would silently re-point level-less grants. isActive drives
// archive/restore.
export const updateGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
    icon: z.string().trim().max(100).nullable().optional(),
    color: z.string().trim().max(50).nullable().optional(),
    tables: z.array(z.string().trim().min(1)).max(200).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No fields to update' });
