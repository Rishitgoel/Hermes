import { z } from 'zod';

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
