import { z } from 'zod';

export const submitUserCreationSchema = z.object({
  justification: z
    .string()
    .min(10, 'Justification must be at least 10 characters long')
    .max(1000, 'Justification must not exceed 1000 characters'),
  // Which platform this account is for. When omitted, the controller falls back to
  // the configured default platform (config.platform.default), so existing
  // single-platform callers keep working. Validated against the live registry at
  // the service boundary.
  platform: z.string().min(1).max(40).optional(),
});

export const reviewUserCreationSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED'], {
    errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
  }),
  note: z.string().max(250, 'Review notes must not exceed 250 characters').optional(),
});
