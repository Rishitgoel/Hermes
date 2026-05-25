import { z } from 'zod';
export declare const createRequestSchema: z.ZodObject<{
    groupId: z.ZodString;
    justification: z.ZodString;
    duration: z.ZodNativeEnum<{
        ONE_DAY: "ONE_DAY";
        ONE_WEEK: "ONE_WEEK";
        ONE_MONTH: "ONE_MONTH";
        THREE_MONTHS: "THREE_MONTHS";
        PERMANENT: "PERMANENT";
    }>;
}, "strip", z.ZodTypeAny, {
    groupId: string;
    justification: string;
    duration: "ONE_DAY" | "ONE_WEEK" | "ONE_MONTH" | "THREE_MONTHS" | "PERMANENT";
}, {
    groupId: string;
    justification: string;
    duration: "ONE_DAY" | "ONE_WEEK" | "ONE_MONTH" | "THREE_MONTHS" | "PERMANENT";
}>;
export declare const reviewRequestSchema: z.ZodObject<{
    status: z.ZodEnum<["APPROVED", "REJECTED"]>;
    note: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "APPROVED" | "REJECTED";
    note?: string | undefined;
}, {
    status: "APPROVED" | "REJECTED";
    note?: string | undefined;
}>;
