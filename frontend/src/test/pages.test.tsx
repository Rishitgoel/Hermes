import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../contexts/AuthContext';
import Dashboard from '../pages/Dashboard';
import apiClient from '../services/apiClient';

// Mock apiClient
vi.mock('../services/apiClient', () => ({
  default: {
    get: vi.fn(),
  },
}));

describe('Pages Smoke Tests', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    vi.mocked(apiClient.get).mockImplementation(async (url) => {
      if (url === '/auth/me') {
        return {
          data: {
            id: 'regular-user-uuid-3333',
            username: 'Rishit_Goel',
            email: 'rishit.goel@bachatt.app',
            roles: ['hermes_user'],
            adminScopes: { superAdmin: false, platforms: [], groups: [] },
          },
        };
      }
      if (url === '/api/user-access/me') {
        return { data: [] };
      }
      if (url === '/api/groups') {
        return { data: [] };
      }
      if (url === '/api/platforms') {
        return { data: [] };
      }
      if (url === '/api/user-creation-requests/me/all') {
        return { data: [] };
      }
      return { data: {} };
    });
  });

  it('renders Dashboard without crashing', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <Dashboard />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    );

    // Verify loading spinner is replaced by page content after loading resolves
    await waitFor(() => {
      expect(screen.getByText(/Welcome back, Rishit Goel/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/My Active Access/i)).toBeInTheDocument();
    expect(screen.getByText(/Browse Groups/i)).toBeInTheDocument();
  });
});
