import { z } from 'zod';

export const groupSlugSchema = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens');
export const groupIdSchema = z.string().uuid('Invalid Group ID format');
