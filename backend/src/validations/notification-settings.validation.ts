import { z } from 'zod';
import { ALL_SCENARIO_KEYS } from '../services/notification-scenarios';

/**
 * Flipping one switch on the notification switchboard.
 *
 * The two master kill switches ride the same shape as a pseudo-scenario called
 * `master`, which cannot collide with a real key — every real scenario key
 * contains at least one dot.
 */
export const updateNotificationSettingSchema = z.object({
  scenario: z
    .string()
    .trim()
    .min(1, 'A scenario key is required')
    .refine(
      value => value === 'master' || ALL_SCENARIO_KEYS.includes(value),
      'Unknown notification scenario',
    ),
  channel: z.enum(['email', 'slack'], {
    errorMap: () => ({ message: "Channel must be 'email' or 'slack'" }),
  }),
  enabled: z.boolean({
    required_error: 'enabled is required',
    invalid_type_error: 'enabled must be true or false',
  }),
});

/**
 * Sending a test message. Deliberately has no recipient field — the test always
 * goes to the caller's own address, so this endpoint can never be used to send
 * mail or DMs to anyone else.
 */
export const testNotificationSchema = z.object({
  channel: z.enum(['email', 'slack'], {
    errorMap: () => ({ message: "Channel must be 'email' or 'slack'" }),
  }),
});
