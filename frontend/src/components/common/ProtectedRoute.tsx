import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import LoadingSpinner from './LoadingSpinner';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: string[];
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, allowedRoles }) => {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/" replace />;
  }

  if (allowedRoles) {
    const hasRole = allowedRoles.some((role) => user.roles.includes(role));
    if (!hasRole) {
      return (
        <div style={{ padding: '40px', textAlign: 'center', marginTop: '80px' }}>
          <h2 style={{ fontFamily: 'Outfit, sans-serif', fontSize: '28px', color: '#c53030', marginBottom: '16px' }}>
            Access Denied
          </h2>
          <p style={{ color: '#4a5568', fontSize: '16px' }}>
            You do not have permission to access this page. Please contact your administrator.
          </p>
        </div>
      );
    }
  }

  return <>{children}</>;
};

export default ProtectedRoute;
