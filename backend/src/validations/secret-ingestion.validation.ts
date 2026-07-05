import { z } from 'zod';

const entrySchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, 'Key name cannot be empty')
    .max(512, 'Key name is too long'),
  value: z.string().max(50000, 'Value is too large'),
});

export const submitIngestionSchema = z.object({
  secretName: z
    .string()
    .trim()
    .min(1, 'Secret name cannot be empty')
    .max(512, 'Secret name is too long'),
  justification: z
    .string()
    .trim()
    .max(1000, 'Justification must not exceed 1000 characters')
    .optional(),
  entries: z
    .array(entrySchema)
    .min(1, 'At least one entry is required')
    .max(200, 'Cannot submit more than 200 entries at once'),
});

export const reviewIngestionSchema = z.object({
  decisions: z
    .array(
      z.object({
        key: z.string().min(1, 'Key name cannot be empty'),
        decision: z.enum(['APPROVED', 'REJECTED'], {
          errorMap: () => ({ message: 'decision must be APPROVED or REJECTED' }),
        }),
      })
    )
    .min(1, 'At least one decision is required')
    .max(200, 'Too many decisions'),
  note: z.string().max(250, 'Review notes must not exceed 250 characters').optional(),
});
