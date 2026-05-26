import { z } from 'zod';
export declare const auditQuerySchema: z.ZodObject<{
    action: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    search?: string | undefined;
    action?: string | undefined;
}, {
    search?: string | undefined;
    action?: string | undefined;
}>;
