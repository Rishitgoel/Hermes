import React from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import apiClient from '../../services/apiClient';
import { listPendingUserCreations } from '../../services/api/userCreation';
import { queryKeys } from '../../lib/queryKeys';
import {
  LayoutDashboard,
  Layers,
  FileClock,
  CheckSquare,
  History,
  ShieldCheck,
  Network,
  KeyRound,
  LogOut,
  Sparkles
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const { user, logout, isSimulated, switchSimulatedRole } = useAuth();

  const isSuperAdmin = user?.roles.includes('hermes_super_admin') || false;
  const isGroupAdmin = user?.roles.includes('hermes_group_admin') || false;
  const isPlatformAdmin = user?.roles.includes('hermes_platform_admin') || false;

  // Gate nav on the server-computed adminScopes (mirror-authoritative) so
  // DB-mirrored admins show up even before their Keycloak token carries the role.
  const scopes = user?.adminScopes;

  // Anyone with an admin scope can reach approvals (the server scopes the data:
  // super → all, platform admin → their platform's groups, group admin → their groups).
  const showApprovals =
    (scopes?.superAdmin ?? isSuperAdmin) ||
    (scopes?.platforms?.length ?? 0) > 0 ||
    (scopes?.groups?.length ?? 0) > 0;

  // Admin Management is for super admins and platform admins.
  const showAdminManagement = (scopes?.superAdmin ?? isSuperAdmin) || (scopes?.platforms?.length ?? 0) > 0;

  // Badge = the real number of items waiting in the Pending Approvals queue, not
  // the unread-notification count. Reuses the same query keys as the Pending
  // Approvals page, so reviewing a request (which invalidates these keys) updates
  // the badge automatically. Refetched every 60s to stay live on other pages.
  const { data: pendingRequests = [] } = useQuery<unknown[]>({
    queryKey: queryKeys.pendingRequests(),
    queryFn: () => apiClient.get('/api/access-requests/pending').then((r) => r.data),
    enabled: showApprovals,
    refetchInterval: 60000,
  });
  const { data: pendingUserCreations = [] } = useQuery({
    queryKey: queryKeys.pendingUserCreations(),
    queryFn: listPendingUserCreations,
    enabled: isSuperAdmin,
    refetchInterval: 60000,
  });
  const pendingApprovalsCount = pendingRequests.length + pendingUserCreations.length;

  const handleRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    switchSimulatedRole(e.target.value as any);
  };

  const getSimulatedRoleValue = () => {
    if (isSuperAdmin) return 'super_admin';
    if (isPlatformAdmin) return 'platform_admin';
    if (isGroupAdmin) return 'group_admin';
    return 'user';
  };

  return (
    <aside className="sidebar">
      {/* Logo Section */}
      <div className="logo-container">
        <img src="/assets/logo.png" alt="Bachatt Logo" className="logo-img" />
        <span className="logo-text">HERMES</span>
      </div>

      {/* Navigation Links */}
      <nav className="nav-links">
        <NavLink 
          to="/" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          end
        >
          <LayoutDashboard size={20} />
          <span>Dashboard</span>
        </NavLink>

        <NavLink 
          to="/groups" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <Layers size={20} />
          <span>Platforms</span>
        </NavLink>

        <NavLink 
          to="/my-requests" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <FileClock size={20} />
          <span>My Requests</span>
        </NavLink>

        {showApprovals && (
          <NavLink 
            to="/pending-approvals" 
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <CheckSquare size={20} />
            <span>Pending Approvals</span>
            {pendingApprovalsCount > 0 && <span className="nav-badge">{pendingApprovalsCount}</span>}
          </NavLink>
        )}

        {showAdminManagement && (
          <NavLink
            to="/admin"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <ShieldCheck size={20} />
            <span>Admin Management</span>
          </NavLink>
        )}

        {user?.hasZookeeperAccess && (
          <NavLink
            to="/zookeeper"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <Network size={20} />
            <span>ZooKeeper Config</span>
          </NavLink>
        )}

        {user?.hasSecretsAccess && (
          <NavLink
            to="/secrets"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <KeyRound size={20} />
            <span>Secret Ingestion</span>
          </NavLink>
        )}

        {isSuperAdmin && (
          <NavLink
            to="/audit-log"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <History size={20} />
            <span>Audit Log</span>
          </NavLink>
        )}
      </nav>

      {/* Bottom Switcher Panel (if simulated) */}
      {isSimulated && (
        <div className="simulation-panel">
          <div className="simulation-title">
            <Sparkles size={14} />
            <span>Role Switcher</span>
          </div>
          <select 
            value={getSimulatedRoleValue()} 
            onChange={handleRoleChange}
            className="simulation-select"
          >
            <option value="user">Regular User</option>
            <option value="group_admin">Group Admin</option>
            <option value="platform_admin">Platform Admin</option>
            <option value="super_admin">Super Admin</option>
          </select>
        </div>
      )}

      {/* Logout button */}
      <button 
        onClick={logout} 
        className="nav-item" 
        style={{ marginTop: isSimulated ? '12px' : 'auto', background: 'none', border: 'none', width: '100%', textAlign: 'left' }}
      >
        <LogOut size={20} />
        <span>Logout</span>
      </button>
    </aside>
  );
};

export default Sidebar;
