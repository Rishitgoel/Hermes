import { AxiosInstance } from 'axios';
interface HttpClientOptions {
    baseURL: string;
    timeout?: number;
    maxRetries?: number;
    retryDelay?: number;
    headers?: Record<string, string>;
}
export declare function createHttpClient(opts: HttpClientOptions): AxiosInstance;
export {};
