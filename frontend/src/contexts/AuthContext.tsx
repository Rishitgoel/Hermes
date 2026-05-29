import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import Keycloak from 'keycloak-js';
import apiClient from '../services/apiClient';

// Mirror of UserCreationStatus enum in the backend.
export type UserCreationStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'AWAITING_SETUP'
  | 'COMPLETED';

export interface UserCreationInfo {
  id: string;
  status: UserCreationStatus;
  justification: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  inviteSentAt: string | null;
  inviteError: string | null;
  /** Redash one-time setup URL — present while AWAITING_SETUP, null once COMPLETED. */
  inviteLink: string | null;
  completedAt: string | null;
  externalUserId: number | null;
  rejectionReason: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
}

export interface UserSession {
  id: string;
  username: string;
  email: string;
  roles: string[];
  userCreation?: UserCreationInfo | null;
}

interface AuthContextType {
  user: UserSession | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isSimulated: boolean;
  login: () => void;
  logout: () => void;
  switchSimulatedRole: (role: 'super_admin' | 'group_admin' | 'user') => void;
  refreshUserCreation: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Setup simulation flags — opt-in only. A missing/typo'd env var must NOT silently
// enable simulation (which would read the localStorage mock token as the bearer).
const useSimulation =
  import.meta.env.VITE_KEYCLOAK_SIMULATION === 'true' && import.meta.env.MODE !== 'production';

// Keycloak client singleton (for live mode)
let keycloakInstance: Keycloak | null = null;
if (!useSimulation) {
  keycloakInstance = new Keycloak({
    url: import.meta.env.VITE_KEYCLOAK_URL || 'https://keycloak.bachatt.app',
    realm: import.meta.env.VITE_KEYCLOAK_REALM || 'master',
    clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'hermes-prod',
  });
  (window as any).keycloak = keycloakInstance; // Make available to apiClient
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserSession | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Helper: re-fetch /auth/me to refresh user-creation status. Used both on
  // initial load and after Resend Invite / Sync Now on the AccountStatus page.
  const fetchMe = useCallback(async (fallback?: UserSession) => {
    try {
      const res: any = await apiClient.get('/auth/me');
      setUser(res.data as UserSession);
      setIsAuthenticated(true);
    } catch (err) {
      console.error('Failed to fetch /auth/me:', err);
      if (fallback) {
        setUser(fallback);
        setIsAuthenticated(true);
      }
    }
  }, []);

  const refreshUserCreation = useCallback(async () => {
    await fetchMe(user ?? undefined);
  }, [fetchMe, user]);

  // Initialize Auth
  useEffect(() => {
    let tokenRefreshIntervalId: number | null = null;

    if (useSimulation) {
      // Simulation mode — pick a mock role, push it into localStorage as the bearer
      // token, then ask the backend who we are (this also lazily auto-creates the
      // user-creation DRAFT row server-side).
      const mockRole = localStorage.getItem('hermes_mock_token') as 'super_admin' | 'group_admin' | 'user' || 'user';
      localStorage.setItem('hermes_mock_token', mockRole);

      let fallbackUser: UserSession;
      if (mockRole === 'super_admin') {
        fallbackUser = {
          id: 'super-admin-uuid-1111',
          username: 'Mayank_Aggarwal',
          email: 'mayank.aggarwal@bachatt.app',
          roles: ['hermes_super_admin', 'hermes_user'],
        };
      } else if (mockRole === 'group_admin') {
        fallbackUser = {
          id: 'group-admin-uuid-2222',
          username: 'Yogesh_Verma',
          email: 'yogesh.verma@bachatt.app',
          roles: ['hermes_group_admin', 'hermes_group_admin_growth', 'hermes_user'],
        };
      } else {
        fallbackUser = {
          id: 'regular-user-uuid-3333',
          username: 'Rishit_Goel',
          email: 'rishit.goel@bachatt.app',
          roles: ['hermes_user'],
        };
      }

      fetchMe(fallbackUser).finally(() => setIsLoading(false));
    } else {
      // Live Keycloak mode
      if (!keycloakInstance) return;

      keycloakInstance
        .init({
          onLoad: 'login-required',
          checkLoginIframe: false,
        })
        .then((authenticated) => {
          if (authenticated) {
            // Refresh the access token whenever Keycloak signals expiry.
            keycloakInstance!.onTokenExpired = () => {
              keycloakInstance!.updateToken(30).catch(() => keycloakInstance!.login());
            };

            tokenRefreshIntervalId = window.setInterval(() => {
              keycloakInstance!.updateToken(70).catch(() => keycloakInstance!.login());
            }, 60_000);

            const roles = keycloakInstance?.realmAccess?.roles || [];
            const fallback: UserSession = {
              id: keycloakInstance?.subject || '',
              username: keycloakInstance?.tokenParsed?.preferred_username || '',
              email: keycloakInstance?.tokenParsed?.email || '',
              roles,
            };

            fetchMe(fallback).finally(() => setIsLoading(false));
          } else {
            setIsAuthenticated(false);
            setIsLoading(false);
          }
        })
        .catch((err) => {
          console.error('Keycloak initialization failed:', err);
          setIsLoading(false);
        });
    }

    return () => {
      if (tokenRefreshIntervalId !== null) {
        window.clearInterval(tokenRefreshIntervalId);
      }
    };
    // fetchMe is stable (no deps); we intentionally only run this once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = () => {
    if (useSimulation) {
      setIsAuthenticated(true);
    } else {
      keycloakInstance?.login();
    }
  };

  const logout = () => {
    if (useSimulation) {
      localStorage.removeItem('hermes_mock_token');
      setUser(null);
      setIsAuthenticated(false);
      window.location.reload();
    } else {
      keycloakInstance?.logout({ redirectUri: window.location.origin });
    }
  };

  const switchSimulatedRole = (role: 'super_admin' | 'group_admin' | 'user') => {
    if (!useSimulation) return;
    localStorage.setItem('hermes_mock_token', role);
    window.location.reload();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isLoading,
        isSimulated: useSimulation,
        login,
        logout,
        switchSimulatedRole,
        refreshUserCreation,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
