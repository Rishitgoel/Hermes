"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const config_1 = __importDefault(require("./config"));
const prisma = new client_1.PrismaClient({
    log: config_1.default.isDev ? ['query', 'info', 'warn', 'error'] : ['error', 'warn'],
    // Connection pool size is controlled via the DATABASE_URL query param:
    // ?connection_limit=10&pool_timeout=30
});
exports.default = prisma;
