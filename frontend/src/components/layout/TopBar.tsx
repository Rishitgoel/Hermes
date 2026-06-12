import React, { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useNotifications, Notification } from '../../contexts/NotificationContext';
import { getPageTitle } from '../../lib/routeTitles';
import { Bell } from 'lucide-react';

export const TopBar: React.FC = () => {
  const { user } = useAuth();
  const { notifications, unreadCount, markAsRead, markAllRead } = useNotifications();
  const location = useLocation();
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const pageTitle = getPageTitle(location.pathname);

  // Keep the browser tab title in sync with the current page.
  useEffect(() => {
    document.title = pageTitle === 'Hermes' ? 'Hermes — Access Management' : `${pageTitle} — Hermes`;
  }, [pageTitle]);

  const getInitials = (name: string) => {
    return name
      .split('_')
      .join(' ')
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);
  };

  // Show the user's highest admin tier (super → platform → group). Prefer the
  // server-computed adminScopes (mirror-authoritative, so a freshly-assigned admin
  // is labelled correctly before their JWT refreshes); fall back to raw role
  // strings. Platform admins were previously mislabelled "Group Admin" because the
  // platform tier was never checked, and a platform-admin who also holds a
  // group-admin role hit the group branch first.
  const getPrimaryRoleLabel = (): string => {
    const scopes = user?.adminScopes;
    const roles = user?.roles ?? [];
    if ((scopes?.superAdmin ?? false) || roles.includes('hermes_super_admin')) return 'Super Admin';
    if ((scopes?.platforms?.length ?? 0) > 0 || roles.includes('hermes_platform_admin')) return 'Platform Admin';
    if ((scopes?.groups?.length ?? 0) > 0 || roles.includes('hermes_group_admin')) return 'Group Admin';
    return 'Employee';
  };

  const handleNotificationClick = async (notif: Notification) => {
    if (!notif.isRead) {
      await markAsRead(notif.id);
    }
    setDropdownOpen(false);
    if (notif.linkUrl) {
      navigate(notif.linkUrl);
    }
  };

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <header className="topbar">
      <h2 className="topbar-title">{pageTitle}</h2>

      <div className="topbar-actions">
        {/* Notification Bell Dropdown */}
        <div className="notification-bell-container" ref={dropdownRef}>
          <button 
            className="bell-button" 
            onClick={() => setDropdownOpen(!dropdownOpen)}
            aria-label="Toggle notifications"
          >
            <Bell size={22} />
            {unreadCount > 0 && <span className="bell-badge">{unreadCount}</span>}
          </button>

          {dropdownOpen && (
            <div className="notification-dropdown">
              <div className="notification-header">
                <h4>Notifications</h4>
                {unreadCount > 0 && (
                  <button className="mark-all-read-btn" onClick={markAllRead}>
                    Mark all read
                  </button>
                )}
              </div>
              <div className="notification-list">
                {notifications.length === 0 ? (
                  <div className="notification-empty">
                    No notifications yet.
                  </div>
                ) : (
                  notifications.map((notif) => (
                    <div 
                      key={notif.id} 
                      className={`notification-item ${!notif.isRead ? 'unread' : ''}`}
                      onClick={() => handleNotificationClick(notif)}
                    >
                      <span className="notification-item-title">{notif.title}</span>
                      <span className="notification-item-msg">{notif.message}</span>
                      <span className="notification-item-time">{formatTime(notif.createdAt)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* User Profile Info — display only (this slot is reserved for a future use). */}
        {user && (
          <div className="user-profile">
            <div className="user-avatar">
              {getInitials(user.username)}
            </div>
            <div className="user-details">
              <span className="user-name">{user.username.replace('_', ' ')}</span>
              {getPrimaryRoleLabel() !== 'Employee' && (
                <span className="user-role-badge">{getPrimaryRoleLabel()}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
};

export default TopBar;
