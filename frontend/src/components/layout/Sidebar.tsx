import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useNotifications } from '../../contexts/NotificationContext';
import { 
  LayoutDashboard, 
  Layers, 
  FileClock, 
  CheckSquare, 
  History, 
  LogOut,
  Sparkles
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const { user, logout, isSimulated, switchSimulatedRole } = useAuth();
  const { unreadCount } = useNotifications();

  const isSuperAdmin = user?.roles.includes('hermes_super_admin') || false;
  const isGroupAdmin = user?.roles.includes('hermes_group_admin') || false;
  const showApprovals = isSuperAdmin || isGroupAdmin;

  const handleRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    switchSimulatedRole(e.target.value as any);
  };

  const getSimulatedRoleValue = () => {
    if (isSuperAdmin) return 'super_admin';
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
          <span>Groups</span>
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
            {unreadCount > 0 && <span className="nav-badge">{unreadCount}</span>}
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
