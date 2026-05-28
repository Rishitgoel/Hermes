import { z } from 'zod';

export const submitUserCreationSchema = z.object({
  justification: z
    .string()
    .min(10, 'Justification must be at least 10 characters long')
    .max(1000, 'Justification must not exceed 1000 characters'),
});

export const reviewUserCreationSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED'], {
    errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
  }),
  note: z.string().max(250, 'Review notes must not exceed 250 characters').optional(),
});
