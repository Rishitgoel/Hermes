import { z } from 'zod';
export declare const PlatformEnum: z.ZodEnum<["redash"]>;
export type Platform = z.infer<typeof PlatformEnum>;
