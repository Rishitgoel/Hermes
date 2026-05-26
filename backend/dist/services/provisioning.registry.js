"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.provisioningRegistry = void 0;
const redash_provisioner_1 = require("./redash.provisioner");
const logger_1 = __importDefault(require("../utils/logger"));
class ProvisioningRegistry {
    registry = new Map();
    constructor() {
        // Register standard platform provisioners
        this.register('redash', redash_provisioner_1.redashProvisioner);
    }
    register(platform, adapter) {
        const key = platform.toLowerCase();
        this.registry.set(key, adapter);
        logger_1.default.info(`🔌 Provisioning Registry: Registered provisioner for platform "${key}"`);
    }
    get(platform) {
        const key = platform.toLowerCase();
        const adapter = this.registry.get(key);
        if (!adapter) {
            throw new Error(`No provisioner registered for platform "${platform}"`);
        }
        return adapter;
    }
    has(platform) {
        return this.registry.has(platform.toLowerCase());
    }
    listPlatforms() {
        return Array.from(this.registry.keys());
    }
    async healthCheckAll() {
        const results = {};
        for (const [key, adapter] of this.registry) {
            try {
                results[key] = await adapter.healthCheck();
            }
            catch (err) {
                results[key] = { healthy: false, message: err.message };
            }
        }
        return results;
    }
}
exports.provisioningRegistry = new ProvisioningRegistry();
exports.default = exports.provisioningRegistry;
