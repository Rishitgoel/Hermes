import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import logger from './logger';

interface HttpClientOptions {
  baseURL: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;  // base delay in ms, exponentially backed off
  headers?: Record<string, string>;
}

export function createHttpClient(opts: HttpClientOptions): AxiosInstance {
  const client = axios.create({
    baseURL: opts.baseURL,
    timeout: opts.timeout || 10000,
    headers: opts.headers || {},
  });

  // Retry interceptor
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.retryDelay ?? 1000;

  client.interceptors.response.use(undefined, async (error) => {
    const config = error.config as AxiosRequestConfig & { _retryCount?: number };
    if (!config) {
      return Promise.reject(error);
    }
    
    config._retryCount = config._retryCount || 0;

    const isRetryable = !error.response || error.response.status >= 500 || error.code === 'ECONNABORTED';

    if (isRetryable && config._retryCount < maxRetries) {
      config._retryCount += 1;
      const delay = baseDelay * Math.pow(2, config._retryCount - 1);
      logger.warn({ url: config.url, attempt: config._retryCount, delay }, 'Retrying failed HTTP request');
      await new Promise(resolve => setTimeout(resolve, delay));
      return client(config);
    }

    return Promise.reject(error);
  });

  return client;
}
