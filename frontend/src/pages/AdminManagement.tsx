import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import LoadingSpinner from '../components/common/LoadingSpinner';
import { SkeletonRows } from '../components/common/Skeleton';
import { queryKeys } from '../lib/queryKeys';
import { prettyPlatform, cleanName } from '../components/admin/adminUtils';
import GroupDrawer from '../components/admin/GroupDrawer';
import GroupFormModal from '../components/admin/GroupFormModal';
import ConfirmModal from '../components/admin/ConfirmModal';
import AssignAdminModal, { type AssignTarget } from '../components/admin/AssignAdminModal';
import {
  listManageablePlatforms,
  listManageableGroups,
  listPlatformAdmins,
  removePlatformAdmin,
  type ManageableGroup,
  type PlatformAdminRow,
} from '../services/api/admin';

type Banner = { type: 'success' | 'error'; text: string };

export const AdminManagement: React.FC = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const superAdmin = user?.adminScopes?.superAdmin ?? user?.roles.includes('hermes_super_admin') ?? false;

  const [activePlatform, setActivePlatform] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [removePA, setRemovePA] = useState<PlatformAdminRow | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const platformsQuery = useQuery({
    queryKey: queryKeys.adminPlatforms(),
    queryFn: listManageablePlatforms,
  });

  // Default to the first platform once they load.
  useEffect(() => {
    if (!activePlatform && platformsQuery.data && platformsQuery.data.length > 0) {
      setActivePlatform(platformsQuery.data[0]);
    }
  }, [activePlatform, platformsQuery.data]);

  const platformAdminsQuery = useQuery({
    queryKey: queryKeys.adminPlatformAdmins(activePlatform ?? ''),
    queryFn: () => listPlatformAdmins(activePlatform ?? undefined),
    enabled: superAdmin && !!activePlatform,
  });

  const groupsQuery = useQuery({
    queryKey: queryKeys.adminGroups(activePlatform ?? ''),
    queryFn: () => listManageableGroups(activePlatform ?? undefined),
    enabled: !!activePlatform,
  });

  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);

  // Keep the drawer's group object current as the list refetches (counts, archived
  // state). If the selected group leaves the list (hard-deleted), the drawer closes.
  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );

  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups.filter((g) => {
      if (!showArchived && !g.isActive) return false;
      if (q && !`${g.name} ${g.slug}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [groups, search, showArchived]);

  const archivedCount = useMemo(() => groups.filter((g) => !g.isActive).length, [groups]);

  const removePlatformAdminMutation = useMutation({
    mutationFn: (id: string) => removePlatformAdmin(id),
    onSuccess: () => {
      setBanner({ type: 'success', text: 'Platform admin removed.' });
      setRemovePA(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.adminPlatformAdmins(activePlatform ?? '') });
    },
    onError: (e: any) => setBanner({ type: 'error', text: e.message || 'Failed to remove platform admin.' }),
  });

  if (platformsQuery.isLoading) return <LoadingSpinner />;

  // Distinguish a failed load from a genuinely empty result — otherwise a 500
  // looks identical to "you administer nothing".
  if (platformsQuery.isError) {
    return (
      <div className="empty-state">
        <Icons.AlertTriangle size={44} className="empty-state-icon" style={{ color: 'var(--status-rejected-text)' }} />
        <h3 className="empty-state-title">Couldn't load Admin Management</h3>
        <p className="empty-state-desc">{(platformsQuery.error as any)?.message || 'Something went wrong.'}</p>
        <button type="button" className="btn btn-outline" style={{ marginTop: '12px' }} onClick={() => platformsQuery.refetch()}>
          <Icons.RefreshCw size={15} /> Retry
        </button>
      </div>
    );
  }

  const platforms = platformsQuery.data ?? [];

  if (platforms.length === 0) {
    return (
      <div className="empty-state">
        <Icons.ShieldOff size={44} className="empty-state-icon" />
        <h3 className="empty-state-title">No platforms to manage</h3>
        <p className="empty-state-desc">You don't currently administer any platforms.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="section-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '28px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Icons.ShieldCheck size={28} style={{ color: 'var(--primary)' }} /> Admin Management
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '15px' }}>
          {superAdmin
            ? 'Manage platform admins, group admins, and members across every platform.'
            : 'Manage group admins and members for the platforms you administer.'}
        </p>
      </div>

      {banner && (
        <div
          style={{
            backgroundColor: banner.type === 'success' ? 'var(--status-approved-bg)' : 'var(--status-rejected-bg)',
            color: banner.type === 'success' ? 'var(--status-approved-text)' : 'var(--status-rejected-text)',
            padding: '14px 16px',
            borderRadius: 'var(--radius-md)',
            fontSize: '14px',
            fontWeight: 600,
            marginBottom: '20px',
            border: `1px solid ${banner.type === 'success' ? 'var(--status-approved-text)' : 'var(--status-rejected-text)'}`,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          {banner.type === 'success' ? <Icons.CheckCircle size={18} /> : <Icons.AlertTriangle size={18} />}
          <span style={{ flex: 1 }}>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex' }}>
            <Icons.X size={16} />
          </button>
        </div>
      )}

      {/* Platform selector */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' }}>
        {platforms.map((p) => {
          const active = p === activePlatform;
          return (
            <button
              key={p}
              type="button"
              onClick={() => {
                setActivePlatform(p);
                setSelectedGroupId(null);
                setSearch('');
              }}
              className={active ? 'btn btn-primary' : 'btn btn-outline'}
              style={{ padding: '8px 18px', fontSize: '14px' }}
            >
              <Icons.Database size={15} /> {prettyPlatform(p)}
            </button>
          );
        })}
      </div>

      {/* Platform Admins (super admin only) */}
      {superAdmin && activePlatform && (
        <section style={{ marginBottom: '36px' }}>
          <div className="section-header" style={{ marginBottom: '12px' }}>
            <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icons.UserCog size={20} style={{ color: 'var(--primary)' }} /> {prettyPlatform(activePlatform)} Platform Admins
            </h2>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '6px 14px', fontSize: '13px' }}
              onClick={() => setAssignTarget({ kind: 'platform', platform: activePlatform })}
            >
              <Icons.Plus size={15} /> Add platform admin
            </button>
          </div>
          {platformAdminsQuery.isLoading ? (
            <SkeletonRows count={2} />
          ) : (platformAdminsQuery.data ?? []).length === 0 ? (
            <div className="empty-state" style={{ padding: '24px' }}>
              <Icons.UserCog size={30} className="empty-state-icon" />
              <p className="empty-state-desc" style={{ fontSize: '13px' }}>
                No platform admins for {prettyPlatform(activePlatform)} yet.
              </p>
            </div>
          ) : (
            <div className="table-container">
              <table className="hermes-table">
                <thead>
                  <tr>
                    <th>Admin</th>
                    <th style={{ width: '220px' }}>Assigned</th>
                    <th style={{ width: '120px', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(platformAdminsQuery.data ?? []).map((pa) => (
                    <tr key={pa.id}>
                      <td>
                        <div style={{ fontWeight: 700, fontSize: '14px' }}>{cleanName(pa.userName)}</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{pa.userEmail}</div>
                      </td>
                      <td style={{ color: 'var(--text-light)', fontSize: '13px' }}>
                        by {cleanName(pa.assignedBy)} · {new Date(pa.assignedAt).toLocaleDateString()}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="btn btn-outline btn-danger-outline"
                          style={{ padding: '4px 10px', fontSize: '12px' }}
                          disabled={removePlatformAdminMutation.isPending}
                          onClick={() => setRemovePA(pa)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Groups */}
      <section>
        <div className="section-header" style={{ marginBottom: '12px' }}>
          <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Icons.Layers size={20} style={{ color: 'var(--primary)' }} /> Groups
          </h2>
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: '6px 14px', fontSize: '13px' }}
            disabled={!activePlatform}
            onClick={() => setShowCreate(true)}
          >
            <Icons.Plus size={15} /> New group
          </button>
        </div>

        {/* Toolbar: search + show-archived */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '220px' }}>
            <Icons.Search size={15} style={{ position: 'absolute', top: '11px', left: '12px', color: 'var(--text-light)' }} />
            <input
              type="text"
              className="form-input"
              placeholder="Search groups…"
              style={{ paddingLeft: '36px', height: '38px' }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived{archivedCount > 0 ? ` (${archivedCount})` : ''}
          </label>
        </div>

        {groupsQuery.isLoading ? (
          <SkeletonRows count={4} />
        ) : visibleGroups.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px' }}>
            <Icons.Layers size={30} className="empty-state-icon" />
            <p className="empty-state-desc" style={{ fontSize: '13px' }}>
              {groups.length === 0
                ? 'No groups on this platform yet. Create one with “New group”.'
                : 'No groups match your search.'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {visibleGroups.map((g) => (
              <GroupRow key={g.id} group={g} onClick={() => setSelectedGroupId(g.id)} />
            ))}
          </div>
        )}
      </section>

      {/* Group detail drawer */}
      {selectedGroup && (
        <GroupDrawer group={selectedGroup} onClose={() => setSelectedGroupId(null)} onBanner={setBanner} />
      )}

      {/* Create group */}
      {showCreate && (
        <GroupFormModal
          mode="create"
          platforms={platforms}
          defaultPlatform={activePlatform}
          onClose={() => setShowCreate(false)}
          onSaved={(msg, record) => {
            setBanner({ type: 'success', text: msg });
            setShowCreate(false);
            // The new group may live on a platform other than the active one — switch to
            // it so the (platform-keyed) list shows it. Seed the list cache so the drawer
            // opens immediately, before the invalidated query refetches with real counts.
            setActivePlatform(record.platform);
            queryClient.setQueryData<ManageableGroup[]>(queryKeys.adminGroups(record.platform), (old) => {
              if ((old ?? []).some((g) => g.id === record.id)) return old;
              const seeded: ManageableGroup = { ...record, memberCount: 0, adminCount: 0 };
              return [...(old ?? []), seeded].sort((a, b) => a.name.localeCompare(b.name));
            });
            setSelectedGroupId(record.id);
          }}
          onError={(msg) => setBanner({ type: 'error', text: msg })}
        />
      )}

      {/* Assign platform admin */}
      {assignTarget && (
        <AssignAdminModal
          target={assignTarget}
          onClose={() => setAssignTarget(null)}
          onAssigned={(msg) => {
            setBanner({ type: 'success', text: msg });
            queryClient.invalidateQueries({ queryKey: queryKeys.adminPlatformAdmins(activePlatform ?? '') });
            setAssignTarget(null);
          }}
          onError={(msg) => setBanner({ type: 'error', text: msg })}
        />
      )}

      {/* Remove platform admin confirm */}
      <ConfirmModal
        isOpen={!!removePA}
        title="Remove platform admin"
        danger
        confirmLabel="Remove"
        loading={removePlatformAdminMutation.isPending}
        message={
          removePA
            ? `Remove ${cleanName(removePA.userName)} as a ${prettyPlatform(removePA.platform)} platform admin?`
            : ''
        }
        onConfirm={() => removePA && removePlatformAdminMutation.mutate(removePA.id)}
        onClose={() => setRemovePA(null)}
      />
    </div>
  );
};

// ── Group list row (click to open the drawer) ────────────────────────────────

const GroupRow: React.FC<{ group: ManageableGroup; onClick: () => void }> = ({ group, onClick }) => {
  const LucideIcon = (Icons as any)[group.icon || 'Layers'] || Icons.Layers;
  return (
    <button type="button" className="admin-group-row" onClick={onClick} style={{ opacity: group.isActive ? 1 : 0.6 }}>
      <div
        className="group-icon-box"
        style={{ width: '34px', height: '34px', borderRadius: '8px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <LucideIcon size={18} style={{ color: group.color || 'var(--primary)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: 700, fontSize: '15px' }}>{group.name}</span>
          {!group.isActive && (
            <span className="badge" style={{ fontSize: '10px', background: 'var(--text-light)', color: 'white' }}>
              ARCHIVED
            </span>
          )}
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
          {group.adminCount} admin{group.adminCount === 1 ? '' : 's'} · {group.memberCount} member{group.memberCount === 1 ? '' : 's'}
        </div>
      </div>
      <Icons.ChevronRight size={18} style={{ color: 'var(--text-light)', flexShrink: 0 }} />
    </button>
  );
};

export default AdminManagement;
