"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEventListeners = registerEventListeners;
const event_bus_1 = __importDefault(require("./event-bus"));
const notification_service_1 = __importDefault(require("./notification.service"));
const logger_1 = __importDefault(require("../utils/logger"));
function registerEventListeners() {
    // Wildcard audit log
    event_bus_1.default.on('*', (event) => {
        logger_1.default.info({ eventType: event.type }, `[EventBus] Event: ${event.type}`);
    });
    // Notification listeners
    event_bus_1.default.on('request.created', async (event) => {
        try {
            const { requestId, groupId, groupName, requesterName, justification, duration } = event.payload;
            await notification_service_1.default.notifyRequestCreated(requestId, groupId, groupName, requesterName, justification, duration);
        }
        catch (err) {
            logger_1.default.error('Failed to notify request.created event:', err.message);
        }
    });
    event_bus_1.default.on('request.approved', async (event) => {
        try {
            const { requesterId, groupName, reviewerName, note } = event.payload;
            await notification_service_1.default.notifyRequestReviewed(requesterId, groupName, true, reviewerName, note);
        }
        catch (err) {
            logger_1.default.error('Failed to notify request.approved event:', err.message);
        }
    });
    event_bus_1.default.on('request.rejected', async (event) => {
        try {
            const { requesterId, groupName, reviewerName, note } = event.payload;
            await notification_service_1.default.notifyRequestReviewed(requesterId, groupName, false, reviewerName, note);
        }
        catch (err) {
            logger_1.default.error('Failed to notify request.rejected event:', err.message);
        }
    });
    event_bus_1.default.on('access.revoked', async (event) => {
        try {
            const { userId, groupName, revokerName, reason } = event.payload;
            await notification_service_1.default.notifyAccessRevoked(userId, groupName, revokerName, reason);
        }
        catch (err) {
            logger_1.default.error('Failed to notify access.revoked event:', err.message);
        }
    });
    event_bus_1.default.on('access.expired', async (event) => {
        try {
            const { userId, groupName } = event.payload;
            await notification_service_1.default.notifyAccessExpired(userId, groupName);
        }
        catch (err) {
            logger_1.default.error('Failed to notify access.expired event:', err.message);
        }
    });
    logger_1.default.info('📡 Event listeners registered.');
}
