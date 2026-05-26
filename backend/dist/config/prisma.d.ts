import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient<{
    log: ("info" | "error" | "warn" | "query")[];
}, "info" | "error" | "warn" | "query", import("@prisma/client/runtime/library").DefaultArgs>;
export default prisma;
