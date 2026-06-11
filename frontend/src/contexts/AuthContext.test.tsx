import React from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';
import apiClient from '../services/apiClient';

// Mock the API client
vi.mock('../services/apiClient', () => ({
  default: {
    get: vi.fn(),
  },
}));

// Mock window.location.reload
const originalLocation = window.location;
beforeAll(() => {
  delete (window as any).location;
  window.location = {
    ...originalLocation,
    reload: vi.fn(),
    origin: 'http://localhost:5173',
  } as any;
});

afterAll(() => {
  window.location = originalLocation;
});

// A test component to consume and display AuthContext values
const TestConsumer = () => {
  const { user, isAuthenticated, isLoading, isSimulated, switchSimulatedRole } = useAuth();
  
  if (isLoading) return <div data-testid="loading">Loading...</div>;
  
  return (
    <div>
      <div data-testid="auth-status">{isAuthenticated ? 'Authenticated' : 'Not Authenticated'}</div>
      <div data-testid="sim-status">{isSimulated ? 'Simulated' : 'Live'}</div>
      <div data-testid="username">{user?.username}</div>
      <button data-testid="btn-switch" onClick={() => switchSimulatedRole('super_admin')}>
        Switch to Super
      </button>
    </div>
  );
};

describe('AuthContext (Simulation Mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('should authenticate user as regular user by default', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        id: 'regular-user-uuid-3333',
        username: 'Rishit_Goel',
        email: 'rishit.goel@bachatt.app',
        roles: ['hermes_user'],
        adminScopes: { superAdmin: false, platforms: [], groups: [] },
      },
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    // Initial load state
    expect(screen.getByTestId('loading')).toHaveTextContent('Loading...');

    // Wait for authentication resolution
    await waitFor(() => {
      expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
    });

    expect(screen.getByTestId('auth-status')).toHaveTextContent('Authenticated');
    expect(screen.getByTestId('sim-status')).toHaveTextContent('Simulated');
    expect(screen.getByTestId('username')).toHaveTextContent('Rishit_Goel');
    expect(apiClient.get).toHaveBeenCalledWith('/auth/me');
  });

  it('should switch simulated role and reload page', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        id: 'regular-user-uuid-3333',
        username: 'Rishit_Goel',
        email: 'rishit.goel@bachatt.app',
        roles: ['hermes_user'],
      },
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
    });

    const switchBtn = screen.getByTestId('btn-switch');
    switchBtn.click();

    expect(localStorage.getItem('hermes_mock_token')).toBe('super_admin');
    expect(window.location.reload).toHaveBeenCalled();
  });
});
