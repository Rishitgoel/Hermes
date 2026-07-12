import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import { prettyPlatform } from './adminUtils';
import GroupAdminsTab from './GroupAdminsTab';
import GroupMembersTab from './GroupMembersTab';
import GroupLevelsTab from './GroupLevelsTab';
import GroupSettingsTab from './GroupSettingsTab';
import { type ManageableGroup } from '../../services/api/admin';

type Tab = 'admins' | 'members' | 'levels' | 'settings';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'admins', label: 'Admins', icon: 'UserCheck' },
  { key: 'members', label: 'Members', icon: 'Users' },
  { key: 'levels', label: 'Levels', icon: 'Layers' },
  { key: 'settings', label: 'Settings', icon: 'Settings' },
];

interface GroupDrawerProps {
  group: ManageableGroup;
  /** Platform keys the caller administers — passed through to the Members tab so
   *  it knows whether the caller may create a platform account for a user (see
   *  AddMemberModal's account-gate recovery UI). */
  manageablePlatforms: string[];
  onClose: () => void;
}

/**
 * Right-side slide-in panel for one group, with tabs (Admins / Members / Levels /
 * Settings). Replaces the old inline expand-card so the group list stays a clean
 * list and one group's internals are worked on at a time.
 */
export const GroupDrawer: React.FC<GroupDrawerProps> = ({ group, manageablePlatforms, onClose }) => {
  const [tab, setTab] = useState<Tab>('admins');
  const LucideIcon = (Icons as any)[group.icon || 'Layers'] || Icons.Layers;

  return (
    <div className="admin-drawer-overlay" onClick={onClose}>
      <div className="admin-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${group.name} settings`}>
        {/* Header */}
        <div className="admin-drawer-header">
          <div
            className="group-icon-box"
            style={{ width: '38px', height: '38px', borderRadius: '8px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <LucideIcon size={20} style={{ color: group.color || 'var(--primary)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 700, fontSize: '16px' }}>{group.name}</span>
              {!group.isActive && (
                <span className="badge badge-archived badge-sm">
                  ARCHIVED
                </span>
              )}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {prettyPlatform(group.platform)} · {group.adminCount} admin{group.adminCount === 1 ? '' : 's'} · {group.memberCount} member
              {group.memberCount === 1 ? '' : 's'}
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            <Icons.X size={20} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="admin-drawer-tabs">
          {TABS.map((t) => {
            const TabIcon = (Icons as any)[t.icon] || Icons.Circle;
            return (
              <button
                key={t.key}
                type="button"
                className={`admin-drawer-tab${tab === t.key ? ' active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                <TabIcon size={15} /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="admin-drawer-body">
          {tab === 'admins' && <GroupAdminsTab group={group} />}
          {tab === 'members' && <GroupMembersTab group={group} canCreateAccount={manageablePlatforms.includes(group.platform)} />}
          {tab === 'levels' && <GroupLevelsTab group={group} />}
          {tab === 'settings' && <GroupSettingsTab group={group} onDeleted={onClose} />}
        </div>
      </div>
    </div>
  );
};

export default GroupDrawer;
