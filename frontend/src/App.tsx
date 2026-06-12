import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { ToastProvider } from './contexts/ToastContext';
import MainLayout from './components/layout/MainLayout';
import ProtectedRoute from './components/common/ProtectedRoute';
import ErrorBoundary from './components/common/ErrorBoundary';

// Pages
import Dashboard from './pages/Dashboard';
import Groups from './pages/Groups';
import GroupDetail from './pages/GroupDetail';
import MyRequests from './pages/MyRequests';
import PendingApprovals from './pages/PendingApprovals';
import AuditLog from './pages/AuditLog';
import AdminManagement from './pages/AdminManagement';

import './styles/global.css';

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AuthProvider>
          <NotificationProvider>
            <ToastProvider>
            <Routes>
              <Route path="/" element={<MainLayout />}>
                <Route index element={<Dashboard />} />

                <Route path="groups" element={<Groups />} />
                <Route path="groups/:slug" element={<GroupDetail />} />

                <Route path="my-requests" element={<MyRequests />} />

                <Route
                  path="pending-approvals"
                  element={
                    <ProtectedRoute
                      allowIf={(u) =>
                        (u.adminScopes?.superAdmin ?? u.roles.includes('hermes_super_admin')) ||
                        (u.adminScopes?.platforms?.length ?? 0) > 0 ||
                        (u.adminScopes?.groups?.length ?? 0) > 0
                      }
                    >
                      <PendingApprovals />
                    </ProtectedRoute>
                  }
                />

                <Route
                  path="admin"
                  element={
                    <ProtectedRoute
                      allowIf={(u) =>
                        (u.adminScopes?.superAdmin ?? u.roles.includes('hermes_super_admin')) ||
                        (u.adminScopes?.platforms?.length ?? 0) > 0
                      }
                    >
                      <AdminManagement />
                    </ProtectedRoute>
                  }
                />

                <Route
                  path="audit-log"
                  element={
                    <ProtectedRoute allowedRoles={['hermes_super_admin']}>
                      <AuditLog />
                    </ProtectedRoute>
                  }
                />
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </ToastProvider>
          </NotificationProvider>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
};

export default App;
