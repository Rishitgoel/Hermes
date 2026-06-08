import { z } from 'zod';

export const submitUserCreationSchema = z.object({
  justification: z
    .string()
    .min(10, 'Justification must be at least 10 characters long')
    .max(1000, 'Justification must not exceed 1000 characters'),
  // Which platform this account is for. Defaults to "redash" (the login-default)
  // when omitted, so existing single-platform callers keep working.
  platform: z.string().min(1).max(40).optional(),
});

export const reviewUserCreationSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED'], {
    errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
  }),
  note: z.string().max(250, 'Review notes must not exceed 250 characters').optional(),
});
