import React from 'react';
import { useSearchParams } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import NotificationSettingsTab from '../components/settings/NotificationSettingsTab';
import UserOnboardingTab from '../components/settings/UserOnboardingTab';
import PlatformSettingsTab from '../components/settings/PlatformSettingsTab';

type Tab = 'notifications' | 'onboarding' | 'platform';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'notifications', label: 'Notifications', icon: 'Bell' },
  { key: 'onboarding', label: 'User Onboarding', icon: 'UserPlus' },
  { key: 'platform', label: 'Platform', icon: 'SlidersHorizontal' },
];

const isTab = (value: string | null): value is Tab =>
  TABS.some((t) => t.key === value);

/**
 * Super-admin settings. The active tab lives in `?tab=` so other pages (and the
 * credential warning on the Notifications grid) can deep-link into the right one.
 *
 * The role check is done here rather than only on the route so the page is safe
 * wherever it is mounted — the backend enforces it regardless.
 */
export const Settings: React.FC = () => {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const superAdmin =
    user?.adminScopes?.superAdmin ?? user?.roles.includes('hermes_super_admin') ?? false;

  const param = searchParams.get('tab');
  const tab: Tab = isTab(param) ? param : 'notifications';

  const setTab = (next: Tab) => {
    // replace: a tab switch is not a navigation step worth a back-button entry.
    setSearchParams(next === 'notifications' ? {} : { tab: next }, { replace: true });
  };

  if (!superAdmin) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <Icons.ShieldOff size={28} />
        </div>
        <div className="empty-state-title">Super admin access required</div>
        <div className="empty-state-desc">
          These settings change how Hermes behaves for everyone, so they are limited to super
          admins.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => {
          const TabIcon = (Icons as any)[t.icon] || Icons.Circle;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`settings-tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <TabIcon size={15} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'notifications' && <NotificationSettingsTab />}
      {tab === 'onboarding' && <UserOnboardingTab />}
      {tab === 'platform' && <PlatformSettingsTab />}
    </div>
  );
};

export default Settings;
