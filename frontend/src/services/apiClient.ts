import axios, { type AxiosResponse } from 'axios';
import keycloak from '@/services/keycloak';

const baseUrl =
  import.meta.env.VITE_HERMES_BASE_URL ||
  import.meta.env.VITE_BASE_URL_BACKEND ||
  // Hermes' own backend port. (The admin-panel copy of this file defaults to
  // 8000, which is that app's port — wrong for this repo.)
  'http://localhost:8001';

export class ApiClientError extends Error {
  statusCode: number;
  errorCode: string;
  context?: any;

  constructor(message: string, statusCode: number, errorCode: string, context?: any) {
    super(message);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.context = context;
  }
}

const hermesApiClient = axios.create({
  baseURL: baseUrl,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

hermesApiClient.interceptors.request.use(
  async (config) => {
    // Prefix all hermes API paths with /hermes (backend is mounted there)
    if (config.url && !config.url.startsWith('/hermes')) {
      config.url = '/hermes' + config.url;
    }

    // Refresh token if expiring soon, then attach to request
    try {
      await keycloak.updateToken(30);
    } catch {
      // ignore — 401 interceptor below will redirect to login
    }

    const token = keycloak.token;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  },
  (error) => Promise.reject(error),
);

hermesApiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    const resData = response.data;

    if (resData && typeof resData === 'object' && 'success' in resData) {
      if (resData.success) {
        // Preserve the envelope's metadata (e.g. pagination `total`) alongside the
        // unwrapped data — paginated callers read it via `res.metadata.total`.
        // Set it on `response` before the spread so it survives as an own property.
        (response as unknown as { metadata?: unknown }).metadata = resData.metadata;
        return { ...response, data: resData.data };
      } else {
        return Promise.reject(
          new ApiClientError(
            resData.error || 'Request failed',
            response.status,
            resData.metadata?.errorCode || 'API_ERROR',
            resData.metadata?.context,
          ),
        );
      }
    }
    return response;
  },
  async (error) => {
    if (error instanceof ApiClientError) return Promise.reject(error);

    if (error.response) {
      const status = error.response.status;
      const resData = error.response.data;
      const originalRequest = error.config as typeof error.config & {
        _retriedAfterRefresh?: boolean;
      };

      if (status === 401 && originalRequest && !originalRequest._retriedAfterRefresh) {
        try {
          const refreshed = await keycloak.updateToken(-1);
          if (refreshed) {
            originalRequest._retriedAfterRefresh = true;
            return hermesApiClient(originalRequest);
          }
        } catch {
          keycloak.login();
          return new Promise(() => {});
        }
      }

      if (resData && typeof resData === 'object' && 'error' in resData) {
        return Promise.reject(
          new ApiClientError(
            resData.error,
            status,
            resData.metadata?.errorCode || 'SERVER_ERROR',
            resData.metadata?.context,
          ),
        );
      }

      return Promise.reject(
        new ApiClientError(error.message || 'Server error', status, 'HTTP_ERROR'),
      );
    }

    return Promise.reject(
      new ApiClientError(error.message || 'Network error', 0, 'NETWORK_ERROR'),
    );
  },
);

export default hermesApiClient;
export { hermesApiClient as apiClient };
