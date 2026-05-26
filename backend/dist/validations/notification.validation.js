"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationIdSchema = void 0;
const zod_1 = require("zod");
exports.notificationIdSchema = zod_1.z.string().uuid('Invalid Notification ID');
