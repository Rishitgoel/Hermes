"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const user_access_controller_1 = require("../controllers/user-access.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.get('/me', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new user_access_controller_1.UserAccessController(req, res, next);
    controller.getMyAccess(req, res, next).catch(next);
});
router.get('/group/:groupId', auth_middleware_1.authenticateToken, (0, auth_middleware_1.requireRole)(['atlas_super_admin', 'atlas_group_admin']), (req, res, next) => {
    const controller = new user_access_controller_1.UserAccessController(req, res, next);
    controller.getGroupAccessList(req, res, next).catch(next);
});
router.delete('/:id', auth_middleware_1.authenticateToken, (0, auth_middleware_1.requireRole)(['atlas_super_admin', 'atlas_group_admin']), (req, res, next) => {
    const controller = new user_access_controller_1.UserAccessController(req, res, next);
    controller.revokeAccess(req, res, next).catch(next);
});
router.get('/platform-status/:platform', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new user_access_controller_1.UserAccessController(req, res, next);
    controller.getPlatformStatus(req, res, next).catch(next);
});
router.post('/platform-user/:platform', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new user_access_controller_1.UserAccessController(req, res, next);
    controller.invitePlatformUser(req, res, next).catch(next);
});
exports.default = router;
