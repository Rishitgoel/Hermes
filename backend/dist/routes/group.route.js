"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const group_controller_1 = require("../controllers/group.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.get('/', auth_middleware_1.authenticateToken, (req, res, next) => {
    const groupController = new group_controller_1.GroupController(req, res, next);
    groupController.getGroups(req, res, next).catch(next);
});
router.get('/:slug', auth_middleware_1.authenticateToken, (req, res, next) => {
    const groupController = new group_controller_1.GroupController(req, res, next);
    groupController.getGroupDetail(req, res, next).catch(next);
});
exports.default = router;
