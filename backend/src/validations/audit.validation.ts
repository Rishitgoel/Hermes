import { z } from 'zod';

export const auditQuerySchema = z.object({
  action: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
});
