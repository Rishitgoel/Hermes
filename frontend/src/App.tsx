import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import MainLayout from './components/layout/MainLayout';
import ProtectedRoute from './components/common/ProtectedRoute';

// Pages
import Dashboard from './pages/Dashboard';
import Groups from './pages/Groups';
import GroupDetail from './pages/GroupDetail';
import MyRequests from './pages/MyRequests';
import PendingApprovals from './pages/PendingApprovals';
import AuditLog from './pages/AuditLog';

import './styles/global.css';

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <NotificationProvider>
          <Routes>
            <Route path="/" element={<MainLayout />}>
              {/* Dashboard */}
              <Route index element={<Dashboard />} />
              
              {/* Groups */}
              <Route path="groups" element={<Groups />} />
              <Route path="groups/:slug" element={<GroupDetail />} />
              
              {/* Request history and active status */}
              <Route path="my-requests" element={<MyRequests />} />
              
              {/* Administrative Approvals Queue */}
              <Route 
                path="pending-approvals" 
                element={
                  <ProtectedRoute allowedRoles={['atlas_super_admin', 'atlas_group_admin']}>
                    <PendingApprovals />
                  </ProtectedRoute>
                } 
              />
              
              {/* Admin Audit Trails */}
              <Route 
                path="audit-log" 
                element={
                  <ProtectedRoute allowedRoles={['atlas_super_admin']}>
                    <AuditLog />
                  </ProtectedRoute>
                } 
              />
            </Route>

            {/* Fallback Catch-All */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </NotificationProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

export default App;
