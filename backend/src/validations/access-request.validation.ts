import { z } from 'zod';
import { AccessDuration } from '@prisma/client';

export const createRequestSchema = z.object({
  groupId: z.string().uuid('Invalid Group ID format'),
  justification: z
    .string()
    .trim()
    .min(10, 'Justification must be at least 10 characters long')
    .max(1000, 'Justification must not exceed 1000 characters'),
  duration: z.nativeEnum(AccessDuration, {
    errorMap: () => ({ message: 'Invalid access duration value' }),
  }),
});

export const reviewRequestSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED'], {
    errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
  }),
  note: z.string().max(250, 'Review notes must not exceed 250 characters').optional(),
});
