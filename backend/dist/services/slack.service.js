"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.slackService = exports.SlackService = void 0;
const logger_1 = __importDefault(require("../utils/logger"));
const config_1 = __importDefault(require("../config/config"));
const http_client_1 = require("../utils/http-client");
class SlackService {
    webhookUrl;
    client;
    constructor() {
        const url = config_1.default.slack.webhookUrl;
        this.webhookUrl = url && url.startsWith('http') ? url : null;
        this.client = this.webhookUrl ? (0, http_client_1.createHttpClient)({ baseURL: this.webhookUrl }) : null;
    }
    async sendPing(text) {
        if (!this.client) {
            logger_1.default.info(`💬 [Slack Ping (Simulation)]: ${text}`);
            return;
        }
        try {
            await this.client.post('', { text });
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
