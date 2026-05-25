"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.slackService = exports.SlackService = void 0;
const logger_1 = __importDefault(require("../utils/logger"));
const axios_1 = __importDefault(require("axios"));
class SlackService {
    webhookUrl;
    constructor() {
        const url = process.env.SLACK_WEBHOOK_URL;
        this.webhookUrl = url && url.startsWith('http') ? url : null;
    }
    async sendPing(text) {
        if (!this.webhookUrl) {
            logger_1.default.info(`💬 [Slack Ping (Simulation)]: ${text}`);
            return;
        }
        try {
            await axios_1.default.post(this.webhookUrl, { text });
            logger_1.default.info('💬 Slack ping sent successfully.');
        }
        catch (error) {
            logger_1.default.error('Failed to send Slack ping webhook:', error.message);
            // Fail silently to avoid breaking the request/approval lifecycle on third-party failure
        }
    }
}
exports.SlackService = SlackService;
exports.slackService = new SlackService();
exports.default = exports.slackService;
