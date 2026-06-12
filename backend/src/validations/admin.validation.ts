import { z } from 'zod';
import { AccessDuration } from '@prisma/client';

// userId is a Keycloak user id (the JWT `sub`). It's UUID-shaped in live
// Keycloak but the simulation identities use non-UUID strings, so we only
// require a non-empty string here rather than .uuid().
export const assignPlatformAdminSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required'),
  platform: z.string().trim().min(1, 'platform is required'),
});

export const assignGroupAdminSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required'),
  groupId: z.string().uuid('Invalid Group ID format'),
});

// Admin override: set the level a member holds in a group (Admin Management).
export const setMemberLevelSchema = z.object({
  levelId: z.string().uuid('Invalid Level ID format'),
});

// Admin override: add a user to a group directly (Admin Management → Members tab).
// levelId is optional here — whether it's REQUIRED depends on whether the group has
// active levels, which is enforced in the workflow service (DB-state dependent).
export const addGroupMemberSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required'),
  levelId: z.string().uuid('Invalid Level ID format').optional(),
  duration: z.nativeEnum(AccessDuration, {
    errorMap: () => ({ message: 'Invalid access duration value' }),
  }),
});
