import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import logger from '../utils/logger';
import { AuthenticatedUser } from '../middleware/auth.middleware';
import { ZodTypeAny } from 'zod';
import { BaseError } from '../utils/errors';

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

export default abstract class BaseController {
  protected readonly logger: Logger;
  protected readonly user?: AuthenticatedUser;
  protected readonly req: Request;
  protected readonly res: Response;
  protected readonly next: NextFunction;

  constructor(req: Request, res: Response, next: NextFunction) {
    this.req = req;
    this.res = res;
    this.next = next;

    this.logger = (req as any).log ?? logger;
    this.user = req.user;
  }

  protected createResponse<T>(
    data?: T,
    message?: string,
    metadata?: Partial<ApiResponse<T>['metadata']>,
  ): ApiResponse<T> {
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

  protected createErrorResponse(
    error: string,
    metadata?: Partial<ApiResponse['metadata']>,
  ): ApiResponse {
    return {
      success: false,
      error,
      metadata: {
        timestamp: new Date().toISOString(),
        ...metadata,
      },
    };
  }

  protected sendResponse<T>(
    data?: T,
    message?: string,
    statusCode: number = 200,
    metadata?: Partial<ApiResponse<T>['metadata']>,
  ): void {
    const response = this.createResponse(data, message, metadata);
    this.res.status(statusCode).json(response);
  }

  protected sendErrorResponse(
    error: string,
    statusCode: number = 500,
    metadata?: Partial<ApiResponse['metadata']>,
  ): void {
    const response = this.createErrorResponse(error, metadata);
    this.logger.error({ error, statusCode }, 'Error response sent');
    this.res.status(statusCode).json(response);
  }

  protected handleError(
    error: Error | unknown,
    message: string,
    statusCode: number = 500,
  ): void {
    this.logger.error({ err: error }, message);
    if (error instanceof BaseError) {
      this.sendErrorResponse(error.message, error.statusCode, {
        errorCode: error.errorCode,
        context: error.context,
      });
    } else {
      this.sendErrorResponse(message, statusCode);
    }
  }

  protected validatePagination(): PaginationParams | null {
    const pageNoStr = this.req.headers['pageno'] as string;
    const pageSizeStr = this.req.headers['pagesize'] as string;

    const pageNo = pageNoStr ? Number(pageNoStr) : 1;
    const pageSize = pageSizeStr ? Number(pageSizeStr) : 10;

    if (isNaN(pageNo) || isNaN(pageSize)) {
      this.sendErrorResponse(
        'Invalid pageNo or pageSize: must be valid numbers',
        400,
      );
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

  protected getUserId(): string | null {
    if (!this.user || typeof this.user.id !== 'string') {
      this.sendErrorResponse('User authentication required', 401);
      return null;
    }
    return this.user.id;
  }

  protected sendPaginatedResponse<T>(
    data: T[],
    total: number,
    pagination: PaginationParams,
    message?: string,
  ): void {
    this.sendResponse(data, message, 200, {
      total,
      page: pagination.pageNo,
      pageSize: pagination.pageSize,
    });
  }

  protected validateWithZod<TSchema extends ZodTypeAny>(
    schema: TSchema,
    data: unknown,
    errorMessage: string = 'Invalid request',
  ): { success: true; data: ReturnType<TSchema['parse']> } | { success: false } {
    const result = schema.safeParse(data);
    if (!result.success) {
      this.sendErrorResponse(errorMessage, 400, {
        errorCode: 'VALIDATION_ERROR',
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
