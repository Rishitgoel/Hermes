"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditQuerySchema = void 0;
const zod_1 = require("zod");
exports.auditQuerySchema = zod_1.z.object({
    action: zod_1.z.string().optional(),
    search: zod_1.z.string().max(200).optional(),
});
