"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewRequestSchema = exports.createRequestSchema = void 0;
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
exports.createRequestSchema = zod_1.z.object({
    groupId: zod_1.z.string().uuid('Invalid Group ID format'),
    justification: zod_1.z.string().min(10, 'Justification must be at least 10 characters long'),
    duration: zod_1.z.nativeEnum(client_1.AccessDuration, {
        errorMap: () => ({ message: 'Invalid access duration value' }),
    }),
});
exports.reviewRequestSchema = zod_1.z.object({
    status: zod_1.z.enum(['APPROVED', 'REJECTED'], {
        errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
    }),
    note: zod_1.z.string().max(250, 'Review notes must not exceed 250 characters').optional(),
});
