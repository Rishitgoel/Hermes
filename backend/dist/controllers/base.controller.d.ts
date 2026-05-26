import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { AuthenticatedUser } from '../middleware/auth.middleware';
import { ZodTypeAny } from 'zod';
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
    metadata: {
        timestamp: string;
        total?: number;
        page?: number;
        pageSize?: number;
        requestId?: string;
        context?: unknown;
        stack?: string;
        errorCode?: string;
    };
}
export interface PaginationParams {
    pageNo: number;
    pageSize: number;
}
export interface ValidationResult {
    isValid: boolean;
    missingFields?: string[];
}
export default abstract class BaseController {
    protected readonly logger: Logger;
    protected readonly user?: AuthenticatedUser;
    protected readonly req: Request;
    protected readonly res: Response;
    protected readonly next: NextFunction;
    constructor(req: Request, res: Response, next: NextFunction);
    protected createResponse<T>(data?: T, message?: string, metadata?: Partial<ApiResponse<T>['metadata']>): ApiResponse<T>;
    protected createErrorResponse(error: string, metadata?: Partial<ApiResponse['metadata']>): ApiResponse;
    protected sendResponse<T>(data?: T, message?: string, statusCode?: number, metadata?: Partial<ApiResponse<T>['metadata']>): void;
    protected sendCreated<T>(data?: T, message?: string): void;
    protected sendErrorResponse(error: string, statusCode?: number, metadata?: Partial<ApiResponse['metadata']>): void;
    protected handleError(error: Error | unknown, message: string, statusCode?: number): void;
    protected validateRequiredParams(params: string[]): ValidationResult;
    protected validateRequiredBodyFields(fields: string[]): ValidationResult;
    protected validatePagination(): PaginationParams | null;
    protected getUserId(): string | null;
    protected sendPaginatedResponse<T>(data: T[], total: number, pagination: PaginationParams, message?: string): void;
    protected validateWithZod<TSchema extends ZodTypeAny>(schema: TSchema, data: unknown, errorMessage?: string): {
        success: true;
        data: ReturnType<TSchema['parse']>;
    } | {
        success: false;
    };
}
