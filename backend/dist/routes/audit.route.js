"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const audit_controller_1 = require("../controllers/audit.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.get('/', auth_middleware_1.authenticateToken, (0, auth_middleware_1.requireRole)(['hermes_super_admin']), (req, res, next) => {
    const controller = new audit_controller_1.AuditController(req, res, next);
    controller.getAuditLogs(req, res, next).catch(next);
});
exports.default = router;
