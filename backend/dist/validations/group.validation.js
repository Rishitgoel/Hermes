"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.groupIdSchema = exports.groupSlugSchema = void 0;
const zod_1 = require("zod");
exports.groupSlugSchema = zod_1.z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens');
exports.groupIdSchema = zod_1.z.string().uuid('Invalid Group ID format');
