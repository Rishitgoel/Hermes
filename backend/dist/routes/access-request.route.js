"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const access_request_controller_1 = require("../controllers/access-request.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.post('/', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new access_request_controller_1.AccessRequestController(req, res, next);
    controller.createRequest(req, res, next).catch(next);
});
router.get('/my', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new access_request_controller_1.AccessRequestController(req, res, next);
    controller.getMyRequests(req, res, next).catch(next);
});
router.get('/pending', auth_middleware_1.authenticateToken, (0, auth_middleware_1.requireRole)(['atlas_super_admin', 'atlas_group_admin']), (req, res, next) => {
    const controller = new access_request_controller_1.AccessRequestController(req, res, next);
    controller.getPendingRequests(req, res, next).catch(next);
});
router.get('/:id', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new access_request_controller_1.AccessRequestController(req, res, next);
    controller.getRequestDetail(req, res, next).catch(next);
});
router.put('/:id/review', auth_middleware_1.authenticateToken, (0, auth_middleware_1.requireRole)(['atlas_super_admin', 'atlas_group_admin']), (req, res, next) => {
    const controller = new access_request_controller_1.AccessRequestController(req, res, next);
    controller.reviewRequest(req, res, next).catch(next);
});
exports.default = router;
