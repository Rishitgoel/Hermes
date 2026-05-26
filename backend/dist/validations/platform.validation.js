"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformEnum = void 0;
const zod_1 = require("zod");
// This enum will be extended as new platforms are added
exports.PlatformEnum = zod_1.z.enum(['redash'], {
    errorMap: () => ({ message: 'Unsupported platform. Currently supported: redash' }),
});
