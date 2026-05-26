import { z } from 'zod';

export const notificationIdSchema = z.string().uuid('Invalid Notification ID');
