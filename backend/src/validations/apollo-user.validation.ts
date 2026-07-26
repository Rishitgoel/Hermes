import { z } from 'zod';

/**
 * Creating an Apollo (Keycloak) login. Only the email is required — the username
 * is derived from the name when given, otherwise from the email's local part
 * (see apollo-user.service).
 */
export const createApolloUserSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('A valid email address is required')
    .max(200, 'Email must not exceed 200 characters'),
  firstName: z
    .string()
    .trim()
    .max(60, 'First name must not exceed 60 characters')
    .optional(),
  lastName: z
    .string()
    .trim()
    .max(60, 'Last name must not exceed 60 characters')
    .optional(),
});

/**
 * Regenerating an existing Apollo login's temporary password. Keyed on email —
 * that is what the super admin has to hand; the Keycloak id is resolved
 * server-side.
 */
export const resendApolloPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('A valid email address is required')
    .max(200, 'Email must not exceed 200 characters'),
});
