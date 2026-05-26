"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpClient = createHttpClient;
const axios_1 = __importDefault(require("axios"));
const logger_1 = __importDefault(require("./logger"));
function createHttpClient(opts) {
    const client = axios_1.default.create({
        baseURL: opts.baseURL,
        timeout: opts.timeout || 10000,
        headers: opts.headers || {},
    });
    // Retry interceptor
    const maxRetries = opts.maxRetries ?? 3;
    const baseDelay = opts.retryDelay ?? 1000;
    client.interceptors.response.use(undefined, async (error) => {
        const config = error.config;
        if (!config) {
            return Promise.reject(error);
        }
        config._retryCount = config._retryCount || 0;
        const isRetryable = !error.response || error.response.status >= 500 || error.code === 'ECONNABORTED';
        if (isRetryable && config._retryCount < maxRetries) {
            config._retryCount += 1;
            const delay = baseDelay * Math.pow(2, config._retryCount - 1);
            logger_1.default.warn({ url: config.url, attempt: config._retryCount, delay }, 'Retrying failed HTTP request');
            await new Promise(resolve => setTimeout(resolve, delay));
            return client(config);
        }
        return Promise.reject(error);
    });
    return client;
}
