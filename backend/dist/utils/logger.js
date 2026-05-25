"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const pino_1 = __importDefault(require("pino"));
const isDevelopment = process.env.NODE_ENV !== 'production';
const logger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL || 'info',
    ...(isDevelopment && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                ignore: 'pid,hostname',
                singleLine: false,
                messageFormat: '{levelLabel} - {msg}',
                errorLikeObjectKeys: ['err', 'error'],
            },
        },
    }),
    serializers: {
        err: pino_1.default.stdSerializers.err,
        error: pino_1.default.stdSerializers.err,
        req: pino_1.default.stdSerializers.req,
        res: pino_1.default.stdSerializers.res,
    },
    formatters: {
        level: (label, number) => {
            return { level: number, levelLabel: label.toUpperCase() };
        },
    },
});
exports.default = logger;
