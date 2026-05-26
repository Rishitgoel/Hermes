import React, { createContext, useContext, useState, useEffect } from 'react';
import Keycloak from 'keycloak-js';
import apiClient from '../services/apiClient';

export interface UserSession {
  id: string;
  username: string;
  email: string;
  roles: string[];
}

interface AuthContextType {
  user: UserSession | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isSimulated: boolean;
  login: () => void;
  logout: () => void;
  switchSimulatedRole: (role: 'super_admin' | 'group_admin' | 'user') => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Setup simulation flags
const useSimulation = import.meta.env.VITE_KEYCLOAK_SIMULATION !== 'false';

// Keycloak client singleton (for live mode)
let keycloakInstance: Keycloak | null = null;
if (!useSimulation) {
  keycloakInstance = new Keycloak({
    url: import.meta.env.VITE_KEYCLOAK_URL || 'https://keycloak.bachatt.app',
    realm: import.meta.env.VITE_KEYCLOAK_REALM || 'master',
    clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'atlas-prod',
  });
  (window as any).keycloak = keycloakInstance; // Make available to apiClient
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserSession | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Initialize Auth
  useEffect(() => {
    let tokenRefreshIntervalId: number | null = null;

    if (useSimulation) {
      // Simulation mode
      const mockRole = localStorage.getItem('atlas_mock_token') as 'super_admin' | 'group_admin' | 'user' || 'user';
      localStorage.setItem('atlas_mock_token', mockRole); // ensure set

      let mockUser: UserSession;
      if (mockRole === 'super_admin') {
        mockUser = {
          id: 'super-admin-uuid-1111',
          username: 'Mayank_Aggarwal',
          email: 'mayank.aggarwal@bachatt.app',
          roles: ['atlas_super_admin', 'atlas_user'],
        };
      } else if (mockRole === 'group_admin') {
        mockUser = {
          id: 'group-admin-uuid-2222',
          username: 'Yogesh_Verma',
          email: 'yogesh.verma@bachatt.app',
          roles: ['atlas_group_admin', 'atlas_group_admin_growth', 'atlas_user'],
        };
      } else {
        mockUser = {
          id: 'regular-user-uuid-3333',
          username: 'Rishit_Goel',
          email: 'rishit.goel@bachatt.app',
          roles: ['atlas_user'],
        };
      }

      setUser(mockUser);
      setIsAuthenticated(true);
      setIsLoading(false);
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
            // Without this, tokens silently die after the realm's access-token
            // lifespan (default 5 min) and every subsequent API call 401s.
            keycloakInstance!.onTokenExpired = () => {
              keycloakInstance!.updateToken(30).catch(() => keycloakInstance!.login());
            };

            // Proactive refresh: if the token has <70s left, renew it.
            tokenRefreshIntervalId = window.setInterval(() => {
              keycloakInstance!.updateToken(70).catch(() => keycloakInstance!.login());
            }, 60_000);

            // Fetch backend /auth/me to verify user sync & details
            apiClient.get('/auth/me')
              .then((res: any) => {
                setUser(res.data);
                setIsAuthenticated(true);
                setIsLoading(false);
              })
              .catch((err) => {
                console.error('Failed to sync auth with backend:', err);
                // Fallback to token claims
                const roles = keycloakInstance?.realmAccess?.roles || [];
                setUser({
                  id: keycloakInstance?.subject || '',
                  username: keycloakInstance?.tokenParsed?.preferred_username || '',
                  email: keycloakInstance?.tokenParsed?.email || '',
                  roles: roles,
                });
                setIsAuthenticated(true);
                setIsLoading(false);
              });
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
      localStorage.removeItem('atlas_mock_token');
      setUser(null);
      setIsAuthenticated(false);
      window.location.reload();
    } else {
      keycloakInstance?.logout({ redirectUri: window.location.origin });
    }
  };

  const switchSimulatedRole = (role: 'super_admin' | 'group_admin' | 'user') => {
    if (!useSimulation) return;
    localStorage.setItem('atlas_mock_token', role);
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
