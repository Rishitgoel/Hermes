import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
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
import AccountStatus from './pages/AccountStatus';

import './styles/global.css';

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AuthProvider>
          <NotificationProvider>
            <Routes>
              <Route path="/" element={<MainLayout />}>
                <Route index element={<Dashboard />} />

                <Route path="groups" element={<Groups />} />
                <Route path="groups/:slug" element={<GroupDetail />} />

                <Route path="my-requests" element={<MyRequests />} />
                <Route path="account-status" element={<AccountStatus />} />

                <Route
                  path="pending-approvals"
                  element={
                    <ProtectedRoute allowedRoles={['hermes_super_admin', 'hermes_group_admin']}>
                      <PendingApprovals />
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
          </NotificationProvider>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
};

export default App;
