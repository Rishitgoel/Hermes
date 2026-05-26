"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
const errors_1 = require("../utils/errors");
class BaseController {
    logger;
    user;
    req;
    res;
    next;
    constructor(req, res, next) {
        this.req = req;
        this.res = res;
        this.next = next;
        this.logger = req.log ?? logger_1.default;
        this.user = req.user;
    }
    createResponse(data, message, metadata) {
        if (message) {
            this.logger.info(message);
        }
        return {
            success: true,
            data,
            message,
            metadata: {
                timestamp: new Date().toISOString(),
                ...metadata,
            },
        };
    }
    createErrorResponse(error, metadata) {
        return {
            success: false,
            error,
            metadata: {
                timestamp: new Date().toISOString(),
                ...metadata,
            },
        };
    }
    sendResponse(data, message, statusCode = 200, metadata) {
        const response = this.createResponse(data, message, metadata);
        this.res.status(statusCode).json(response);
    }
    sendCreated(data, message) {
        this.sendResponse(data, message, 201);
    }
    sendErrorResponse(error, statusCode = 500, metadata) {
        const response = this.createErrorResponse(error, metadata);
        this.logger.error({ error, statusCode }, 'Error response sent');
        this.res.status(statusCode).json(response);
    }
    handleError(error, message, statusCode = 500) {
        this.logger.error({ err: error }, message);
        if (error instanceof errors_1.BaseError) {
            this.sendErrorResponse(error.message, error.statusCode, {
                errorCode: error.errorCode,
                context: error.context,
            });
        }
        else {
            this.sendErrorResponse(message, statusCode);
        }
    }
    validateRequiredParams(params) {
        if (!params.length) {
            return { isValid: true };
        }
        const missingParams = params.filter(param => {
            const value = this.req.params[param];
            return !value || (typeof value === 'string' && value.trim() === '');
        });
        if (missingParams.length > 0) {
            this.sendErrorResponse(`Missing required parameters: ${missingParams.join(', ')}`, 400);
            return { isValid: false, missingFields: missingParams };
        }
        return { isValid: true };
    }
    validateRequiredBodyFields(fields) {
        if (!fields.length) {
            return { isValid: true };
        }
        const missingFields = fields.filter(field => {
            const value = this.req.body[field];
            return (value === undefined ||
                value === null ||
                (typeof value === 'string' && value.trim() === ''));
        });
        if (missingFields.length > 0) {
            this.sendErrorResponse(`Missing required fields: ${missingFields.join(', ')}`, 400);
            return { isValid: false, missingFields };
        }
        return { isValid: true };
    }
    validatePagination() {
        const pageNoStr = this.req.headers['pageno'];
        const pageSizeStr = this.req.headers['pagesize'];
        const pageNo = pageNoStr ? Number(pageNoStr) : 1;
        const pageSize = pageSizeStr ? Number(pageSizeStr) : 10;
        if (isNaN(pageNo) || isNaN(pageSize)) {
            this.sendErrorResponse('Invalid pageNo or pageSize: must be valid numbers', 400);
            return null;
        }
        if (pageNo < 1) {
            this.sendErrorResponse('pageNo must be greater than 0', 400);
            return null;
        }
        if (pageSize < 1 || pageSize > 100) {
            this.sendErrorResponse('pageSize must be between 1 and 100', 400);
            return null;
        }
        return { pageNo, pageSize };
    }
    getUserId() {
        if (!this.user || typeof this.user.id !== 'string') {
            this.sendErrorResponse('User authentication required', 401);
            return null;
        }
        return this.user.id;
    }
    sendPaginatedResponse(data, total, pagination, message) {
        this.sendResponse(data, message, 200, {
            total,
            page: pagination.pageNo,
            pageSize: pagination.pageSize,
        });
    }
    validateWithZod(schema, data, errorMessage = 'Invalid request') {
        const result = schema.safeParse(data);
        if (!result.success) {
            this.sendErrorResponse(errorMessage, 400, {
                context: result.error.errors.map(err => ({
                    path: err.path.join('.'),
                    message: err.message,
                })),
            });
            return { success: false };
        }
        return { success: true, data: result.data };
    }
}
exports.default = BaseController;
