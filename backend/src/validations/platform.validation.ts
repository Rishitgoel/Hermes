import { z } from 'zod';

// This enum will be extended as new platforms are added
export const PlatformEnum = z.enum(['redash'], {
  errorMap: () => ({ message: 'Unsupported platform. Currently supported: redash' }),
});

export type Platform = z.infer<typeof PlatformEnum>;
