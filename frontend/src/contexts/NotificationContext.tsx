import React, { createContext, useContext, useState, useEffect } from 'react';
import apiClient from '../services/apiClient';
import { useAuth } from './AuthContext';

export interface Notification {
  id: string;
  userId: string;
  title: string;
  message: string;
  linkUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  fetchNotifications: () => Promise<void>;
  markAsRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isSimulated } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const fetchNotifications = async () => {
    if (!isAuthenticated) return;
    setIsLoading(true);
    try {
      const [response, unreadRes] = await Promise.all([
        apiClient.get('/api/notifications'),
        apiClient.get('/api/notifications/unread-count')
      ]);
      setNotifications(response.data);
      setUnreadCount(unreadRes.data.count);
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const markAsRead = async (id: string) => {
    try {
      await apiClient.put(`/api/notifications/${id}/read`);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  };

  const markAllRead = async () => {
    try {
      await apiClient.put('/api/notifications/read-all');
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error);
    }
  };

  // Live notifications via Server-Sent Events (P2-6) — replaces the old 60s poll.
  // The backend pushes each new notification for this user as it's created; we just
  // keep one EventSource open and append. We still hydrate on mount (and on every
  // reconnect) so the bell is correct even if events were missed while disconnected.
  useEffect(() => {
    if (!isAuthenticated) return;

    fetchNotifications();

    const rawBase = (import.meta.env.VITE_BASE_URL_BACKEND || '').trim();
    let baseUrl = rawBase.startsWith('http') ? rawBase : window.location.origin;
    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1);
    }
    let es: EventSource | null = null;
    let closed = false;
    let reopenTimer: number | null = null;

    // EventSource can't send an Authorization header, so the token rides in the URL.
    // Live: the Keycloak access token (refreshed in the background by AuthContext).
    // Simulation: the mock role string in localStorage.
    const getToken = (): string | null => {
      const kc = (window as { keycloak?: { token?: string } }).keycloak;
      if (kc?.token) return kc.token;
      if (isSimulated) return localStorage.getItem('hermes_mock_token');
      return null;
    };

    const connect = () => {
      if (closed) return;
      const token = getToken();
      if (!token) {
        // Keycloak may still be initialising — retry shortly.
        reopenTimer = window.setTimeout(connect, 2000);
        return;
      }

      es = new EventSource(`${baseUrl}/api/notifications/stream?token=${encodeURIComponent(token)}`);

      es.addEventListener('open', () => {
        // (Re)connected: re-hydrate to catch anything emitted while we were away.
        fetchNotifications();
      });

      es.addEventListener('notification', (ev) => {
        try {
          const n = JSON.parse((ev as MessageEvent).data) as Notification;
          setNotifications((prev) => (prev.some((x) => x.id === n.id) ? prev : [n, ...prev]));
          if (!n.isRead) setUnreadCount((c) => c + 1);
        } catch {
          // Ignore a malformed frame rather than tearing down the stream.
        }
      });

      es.onerror = () => {
        // EventSource would auto-retry with the SAME (possibly expired) token. Close
        // and reopen ourselves so we re-read a refreshed token, with a short backoff.
        es?.close();
        es = null;
        if (closed) return;
        if (reopenTimer) window.clearTimeout(reopenTimer);
        reopenTimer = window.setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reopenTimer) window.clearTimeout(reopenTimer);
      es?.close();
    };
    // fetchNotifications is stable enough for our purposes; re-running only on auth change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isSimulated]);

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        isLoading,
        fetchNotifications,
        markAsRead,
        markAllRead,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
};

export const useNotifications = () => {
  const context = useContext(NotificationContext);
  if (context === undefined) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
};
