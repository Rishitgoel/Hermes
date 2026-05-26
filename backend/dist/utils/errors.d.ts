export declare abstract class BaseError extends Error {
    readonly statusCode: number;
    readonly errorCode: string;
    readonly isOperational: boolean;
    readonly timestamp: Date;
    readonly context?: Record<string, unknown>;
    readonly userId?: string;
    readonly requestId?: string;
    constructor(message: string, statusCode: number, errorCode: string, isOperational?: boolean, context?: Record<string, unknown>, userId?: string, requestId?: string);
    toJSON(): {
        name: string;
        message: string;
        statusCode: number;
        errorCode: string;
        timestamp: string;
        context: Record<string, unknown> | undefined;
        userId: string | undefined;
        requestId: string | undefined;
        stack: string | undefined;
    };
}
export declare class ValidationError extends BaseError {
    constructor(message: string, context?: Record<string, unknown>, userId?: string, requestId?: string);
}
export declare class AuthenticationError extends BaseError {
    constructor(message?: string, context?: Record<string, unknown>, userId?: string, requestId?: string);
}
export declare class AuthorizationError extends BaseError {
    constructor(message?: string, context?: Record<string, unknown>, userId?: string, requestId?: string);
}
export declare class NotFoundError extends BaseError {
    constructor(message: string, context?: Record<string, unknown>, userId?: string, requestId?: string);
}
export declare class ConflictError extends BaseError {
    constructor(message: string, context?: Record<string, unknown>, userId?: string, requestId?: string);
}
export declare class ExternalServiceError extends BaseError {
    constructor(message: string, context?: Record<string, unknown>, userId?: string, requestId?: string);
}
export declare class InternalServerError extends BaseError {
    constructor(message?: string, context?: Record<string, unknown>, userId?: string, requestId?: string);
}
export declare class ErrorMonitor {
    private static instance;
    private errorCounts;
    private recentErrors;
    private readonly maxRecentErrors;
    static getInstance(): ErrorMonitor;
    reportError(error: BaseError | Error, context?: Record<string, unknown>): void;
    private logError;
    private isCriticalError;
    private alertCriticalError;
}
export declare const errorMonitor: ErrorMonitor;
