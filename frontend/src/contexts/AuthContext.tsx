import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import keycloak from '@/services/keycloak';
import hermesApiClient from '../services/apiClient';
import { DEFAULT_PLATFORM } from '../lib/platforms';

export type UserCreationStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'AWAITING_SETUP'
  | 'COMPLETED';

export interface UserCreationInfo {
  id: string;
  platform: string;
  status: UserCreationStatus;
  justification: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  inviteSentAt: string | null;
  inviteError: string | null;
  inviteLink: string | null;
  completedAt: string | null;
  externalUserId: string | null;
  rejectionReason: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
}

export interface AdminScopes {
  superAdmin: boolean;
  platforms: string[];
  groups: string[];
}

export interface UserSession {
  id: string;
  username: string;
  email: string;
  roles: string[];
  userCreation?: UserCreationInfo | null;
  adminScopes?: AdminScopes | null;
  /** Whether to show the ZooKeeper Config page — true when the user holds an active
   *  grant on a `platform='zookeeper'` group (computed server-side in /auth/me). */
  hasZookeeperAccess?: boolean;
  /** Whether to show the Secret Ingestion page — true when the user holds an active
   *  grant on a `platform='secrets'` group (computed server-side in /auth/me). */
  hasSecretsAccess?: boolean;
}

/** Simulation-mode mock identities (maps to the Bearer tokens the backend accepts). */
export type SimRole = 'super_admin' | 'platform_admin' | 'group_admin' | 'user';

interface AuthContextType {
  user: UserSession | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isSimulated: boolean;
  login: () => void;
  logout: () => void;
  switchSimulatedRole: (role: SimRole) => void;
  refreshUserCreation: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Setup simulation flags — opt-in only. A missing/typo'd env var must NOT silently
// enable simulation (which would read the localStorage mock token as the bearer).
const useSimulation =
  import.meta.env.VITE_KEYCLOAK_SIMULATION === 'true' && import.meta.env.MODE !== 'production';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserSession | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Helper: re-fetch /auth/me to refresh user-creation status. Used both on
  // initial load and after Resend Invite / Sync Now on the account-status panel.
  const fetchMe = useCallback(async (fallback?: UserSession) => {
    try {
      const res: any = await hermesApiClient.get('/auth/me');
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
      const mockRole = (localStorage.getItem('hermes_mock_token') as SimRole) || 'user';
      localStorage.setItem('hermes_mock_token', mockRole);

      let fallbackUser: UserSession;
      if (mockRole === 'super_admin') {
        fallbackUser = {
          id: 'super-admin-uuid-1111',
          username: 'Mayank_Aggarwal',
          email: 'mayank.aggarwal@bachatt.app',
          roles: ['hermes_super_admin', 'hermes_user'],
        };
      } else if (mockRole === 'platform_admin') {
        fallbackUser = {
          id: 'platform-admin-uuid-4444',
          username: 'Neha_Sharma',
          email: 'neha.sharma@bachatt.app',
          roles: ['hermes_platform_admin', `hermes_platform_admin_${DEFAULT_PLATFORM}`, 'hermes_user'],
        };
      } else if (mockRole === 'group_admin') {
        fallbackUser = {
          id: 'group-admin-uuid-2222',
          username: 'Yogesh_Verma',
          email: 'yogesh.verma@bachatt.app',
          roles: ['hermes_group_admin', `hermes_group_admin_${DEFAULT_PLATFORM}_growth`, 'hermes_user'],
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
      // Live Keycloak mode. Hermes runs standalone: nothing else on the page
      // initialises Keycloak, so this provider has to. (When this file is
      // vendored into admin-panel the host app has already called init() and
      // this block is replaced by a plain fetchMe() — do not carry that version
      // back here, or no token is ever acquired and every request 401s.)
      keycloak
        .init({ onLoad: 'login-required', checkLoginIframe: false })
        .then((authenticated) => {
          if (!authenticated) {
            setIsAuthenticated(false);
            setIsLoading(false);
            return;
          }

          // Refresh the access token whenever Keycloak signals expiry, and on a
          // timer as a backstop.
          keycloak.onTokenExpired = () => {
            keycloak.updateToken(30).catch(() => keycloak.login());
          };
          tokenRefreshIntervalId = window.setInterval(() => {
            keycloak.updateToken(70).catch(() => keycloak.login());
          }, 60_000);

          const fallback: UserSession = {
            id: keycloak.subject || '',
            username: keycloak.tokenParsed?.preferred_username || '',
            email: keycloak.tokenParsed?.email || '',
            roles: keycloak.realmAccess?.roles || [],
          };
          fetchMe(fallback).finally(() => setIsLoading(false));
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
      keycloak.login();
    }
  };

  const logout = () => {
    if (useSimulation) {
      localStorage.removeItem('hermes_mock_token');
      setUser(null);
      setIsAuthenticated(false);
      window.location.reload();
    } else {
      keycloak.logout({ redirectUri: window.location.origin });
    }
  };

  const switchSimulatedRole = (role: SimRole) => {
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
