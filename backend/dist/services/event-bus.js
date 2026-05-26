"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventBus = void 0;
const events_1 = require("events");
const logger_1 = __importDefault(require("../utils/logger"));
class AtlasEventBus extends events_1.EventEmitter {
    emitAccessEvent(event) {
        logger_1.default.debug({ event: event.type }, `Event emitted: ${event.type}`);
        this.emit(event.type, event);
        this.emit('*', event); // Wildcard listener for audit/logging
    }
}
exports.eventBus = new AtlasEventBus();
exports.default = exports.eventBus;
