import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth, UserSession } from '../../contexts/AuthContext';
import LoadingSpinner from './LoadingSpinner';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: string[];
  /** Custom predicate for access (e.g. admin scopes). Takes precedence over
   *  allowedRoles when provided — useful for tiers that don't map to a single role. */
  allowIf?: (user: UserSession) => boolean;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, allowedRoles, allowIf }) => {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/" replace />;
  }

  const hasAccess = allowIf
    ? allowIf(user)
    : allowedRoles
    ? allowedRoles.some((role) => user.roles.includes(role))
    : true;

  if (!hasAccess) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', marginTop: '80px' }}>
        <h2 style={{ fontSize: '28px', color: '#c53030', marginBottom: '16px' }}>
          Access Denied
        </h2>
        <p style={{ color: '#4a5568', fontSize: '16px' }}>
          You do not have permission to access this page. Please contact your administrator.
        </p>
      </div>
    );
  }

  return <>{children}</>;
};

export default ProtectedRoute;
