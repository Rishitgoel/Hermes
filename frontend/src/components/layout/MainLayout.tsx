import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { useAuth } from '../../contexts/AuthContext';
import LoadingSpinner from '../common/LoadingSpinner';
import ToastViewport from '../common/ToastViewport';
import CommandPalette from '../common/CommandPalette';

export const MainLayout: React.FC = () => {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading || !isAuthenticated) {
    return <LoadingSpinner fullPage />;
  }

  return (
    <div className="app-container">
      <Sidebar />
      <div className="main-wrapper">
        <TopBar />
        <main className="content-pane">
          <Outlet />
        </main>
        <ToastViewport />
        <CommandPalette />
      </div>
    </div>
  );
};

export default MainLayout;
