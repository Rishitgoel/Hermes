import { z } from 'zod';
import { AccessDuration } from '@prisma/client';

export const createRequestSchema = z.object({
  groupId: z.string().uuid('Invalid Group ID format'),
  // Optional here — whether a level is REQUIRED depends on whether the group has
  // active levels, which is enforced in the workflow service (DB-state dependent).
  levelId: z.string().uuid('Invalid Level ID format').optional(),
  justification: z
    .string()
    .trim()
    .min(10, 'Justification must be at least 10 characters long')
    .max(1000, 'Justification must not exceed 1000 characters'),
  duration: z.nativeEnum(AccessDuration, {
    errorMap: () => ({ message: 'Invalid access duration value' }),
  }),
});

// Change the level the requester already holds in a group (promote/demote). Both
// fields are required — unlike createRequestSchema, a level is always supplied
// because changing a level only makes sense for groups that have levels.
export const changeLevelSchema = z.object({
  groupId: z.string().uuid('Invalid Group ID format'),
  levelId: z.string().uuid('Invalid Level ID format'),
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

// Bulk submit (Groups page): one duration shared across all selected groups, each
// with its own justification (custom or general) and optional level. Level
// requiredness is enforced per-item in the workflow service (DB-state dependent).
export const createRequestsBulkSchema = z.object({
  duration: z.nativeEnum(AccessDuration, {
    errorMap: () => ({ message: 'Invalid access duration value' }),
  }),
  requests: z
    .array(
      z.object({
        groupId: z.string().uuid('Invalid Group ID format'),
        levelId: z.string().uuid('Invalid Level ID format').optional(),
        justification: z
          .string()
          .trim()
          .min(10, 'Justification must be at least 10 characters long')
          .max(1000, 'Justification must not exceed 1000 characters'),
      }),
    )
    .min(1, 'At least one request is required')
    .max(50, 'Cannot submit more than 50 requests at once'),
});

// Bulk review (Pending Approvals page): per-item status + optional note.
export const reviewRequestsBulkSchema = z.object({
  items: z
    .array(
      z.object({
        requestId: z.string().uuid('Invalid request ID format'),
        status: z.enum(['APPROVED', 'REJECTED'], {
          errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
        }),
        note: z.string().max(250, 'Review notes must not exceed 250 characters').optional(),
      }),
    )
    .min(1, 'At least one item is required')
    .max(100, 'Cannot review more than 100 requests at once'),
});
