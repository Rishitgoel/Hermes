"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const admin_controller_1 = require("../controllers/admin.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.post('/sync', auth_middleware_1.authenticateToken, (0, auth_middleware_1.requireRole)(['hermes_super_admin']), (req, res, next) => {
    const controller = new admin_controller_1.AdminController(req, res, next);
    controller.triggerSync(req, res, next).catch(next);
});
exports.default = router;
