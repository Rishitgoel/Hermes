import axios, { AxiosResponse } from 'axios';

const baseUrl = import.meta.env.VITE_BASE_URL_BACKEND || 'http://localhost:8001';

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

const apiClient = axios.create({
  baseURL: baseUrl,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

// Request Interceptor: Inject token (live Keycloak token or mock simulation token)
apiClient.interceptors.request.use(
  (config) => {
    // 1. Try to get token from Keycloak JS if active
    let token = (window as any).keycloak?.token;
    
    // 2. Fallback to localStorage mock token in simulation mode ONLY
    const useSimulation = import.meta.env.VITE_KEYCLOAK_SIMULATION !== 'false';
    if (!token && useSimulation) {
      token = localStorage.getItem('atlas_mock_token');
    }

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    
    return config;
  },
  (error) => Promise.reject(error)
);

// Response Interceptor: Unwrap { success: true, data: T } structure
apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    const resData = response.data;
    
    if (resData && typeof resData === 'object' && 'success' in resData) {
      if (resData.success) {
        return { ...response, data: resData.data };
      } else {
        // If success: false is returned inside a 200 OK
        return Promise.reject(
          new ApiClientError(
            resData.error || 'Request failed',
            response.status,
            resData.metadata?.errorCode || 'API_ERROR',
            resData.metadata?.context
          )
        );
      }
    }
    return response;
  },
  (error) => {
    if (error.response) {
      const status = error.response.status;
      const resData = error.response.data;

      // Extract error details from backend custom BaseError shape
      if (resData && typeof resData === 'object' && 'error' in resData) {
        return Promise.reject(
          new ApiClientError(
            resData.error,
            status,
            resData.metadata?.errorCode || 'SERVER_ERROR',
            resData.metadata?.context
          )
        );
      }

      return Promise.reject(
        new ApiClientError(
          error.message || 'Server error',
          status,
          'HTTP_ERROR'
        )
      );
    }
    
    return Promise.reject(new ApiClientError(error.message || 'Network error', 0, 'NETWORK_ERROR'));
  }
);

export default apiClient;
export { apiClient };
