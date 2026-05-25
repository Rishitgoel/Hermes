"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const notification_controller_1 = require("../controllers/notification.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.get('/', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new notification_controller_1.NotificationController(req, res, next);
    controller.getNotifications(req, res, next).catch(next);
});
router.get('/unread-count', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new notification_controller_1.NotificationController(req, res, next);
    controller.getUnreadCount(req, res, next).catch(next);
});
router.put('/read-all', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new notification_controller_1.NotificationController(req, res, next);
    controller.markAllRead(req, res, next).catch(next);
});
router.put('/:id/read', auth_middleware_1.authenticateToken, (req, res, next) => {
    const controller = new notification_controller_1.NotificationController(req, res, next);
    controller.markAsRead(req, res, next).catch(next);
});
exports.default = router;
