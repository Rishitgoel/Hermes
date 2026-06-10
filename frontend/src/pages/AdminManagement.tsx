import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import LoadingSpinner from '../components/common/LoadingSpinner';
import { queryKeys } from '../lib/queryKeys';
import {
  listManageablePlatforms,
  listManageableGroups,
  listPlatformAdmins,
  assignPlatformAdmin,
  removePlatformAdmin,
  listGroupAdmins,
  assignGroupAdmin,
  removeGroupAdmin,
  listGroupMembers,
  removeGroupMember,
  setGroupMemberLevel,
  searchUsers,
  listGroupLevels,
  createGroupLevel,
  updateGroupLevel,
  deleteGroupLevel,
  type AdminUser,
  type ManageableGroup,
  type GroupAdminRow,
  type GroupLevelRow,
  type GroupLevelInput,
} from '../services/api/admin';

const prettyPlatform = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
const cleanName = (n: string) => n.replace(/_/g, ' ');

/** Small debounce so the user-search query doesn't fire on every keystroke. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

type AssignTarget =
  | { kind: 'platform'; platform: string }
  | { kind: 'group'; groupId: string; groupName: string };

export const AdminManagement: React.FC = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const superAdmin = user?.adminScopes?.superAdmin ?? user?.roles.includes('hermes_super_admin') ?? false;

  const [activePlatform, setActivePlatform] = useState<string | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

  const groupAdminsQuery = useQuery({
    queryKey: queryKeys.adminGroupAdmins(activePlatform ?? ''),
    queryFn: () => listGroupAdmins({ platform: activePlatform ?? undefined }),
    enabled: !!activePlatform,
  });

  // group admins keyed by groupId for quick lookup in the group rows.
  const adminsByGroup = useMemo(() => {
    const map: Record<string, GroupAdminRow[]> = {};
    (groupAdminsQuery.data ?? []).forEach((a) => {
      (map[a.groupId] ||= []).push(a);
    });
    return map;
  }, [groupAdminsQuery.data]);

  const invalidatePlatform = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(activePlatform ?? '') });
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupAdmins(activePlatform ?? '') });
    queryClient.invalidateQueries({ queryKey: queryKeys.adminPlatformAdmins(activePlatform ?? '') });
    // Promoting/demoting moves a person between the Admins and Members lists, so
    // refresh every group's members query (prefix match on the adminGroupMembers key).
    queryClient.invalidateQueries({ queryKey: ['admin', 'group-members'] });
  };

  const removePlatformAdminMutation = useMutation({
    mutationFn: (id: string) => removePlatformAdmin(id),
    onSuccess: () => {
      setBanner({ type: 'success', text: 'Platform admin removed.' });
      invalidatePlatform();
    },
    onError: (e: any) => setBanner({ type: 'error', text: e.message || 'Failed to remove platform admin.' }),
  });

  const removeGroupAdminMutation = useMutation({
    mutationFn: (id: string) => removeGroupAdmin(id),
    onSuccess: () => {
      setBanner({ type: 'success', text: "Admin role removed — they're now a regular member (group access kept)." });
      invalidatePlatform();
    },
    onError: (e: any) => setBanner({ type: 'error', text: e.message || 'Failed to remove group admin.' }),
  });

  if (platformsQuery.isLoading) return <LoadingSpinner />;

  // Distinguish a failed load from a genuinely empty result — otherwise a 500
  // looks identical to "you administer nothing".
  if (platformsQuery.isError) {
    return (
      <div className="empty-state">
        <Icons.AlertTriangle size={44} className="empty-state-icon" style={{ color: 'var(--status-rejected-text)' }} />
        <h3 className="empty-state-title">Couldn't load Admin Management</h3>
        <p className="empty-state-desc">
          {(platformsQuery.error as any)?.message || 'Something went wrong.'}
        </p>
        <button
          type="button"
          className="btn btn-outline"
          style={{ marginTop: '12px' }}
          onClick={() => platformsQuery.refetch()}
        >
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

  const groups = groupsQuery.data ?? [];

  return (
    <div>
      {/* Header */}
      <div className="section-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '28px', fontFamily: 'Outfit, sans-serif', display: 'flex', alignItems: 'center', gap: '10px' }}>
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
                setExpandedGroupId(null);
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
            <h2 style={{ fontSize: '20px', fontFamily: 'Outfit, sans-serif', display: 'flex', alignItems: 'center', gap: '8px' }}>
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
            <div style={{ color: 'var(--text-muted)', padding: '12px 0' }}>Loading…</div>
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
                          className="btn btn-outline"
                          style={{ padding: '4px 10px', fontSize: '12px', borderColor: 'var(--status-rejected-text)', color: 'var(--status-rejected-text)' }}
                          disabled={removePlatformAdminMutation.isPending}
                          onClick={() => {
                            if (window.confirm(`Remove ${cleanName(pa.userName)} as a ${prettyPlatform(pa.platform)} platform admin?`)) {
                              removePlatformAdminMutation.mutate(pa.id);
                            }
                          }}
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

      {/* Groups + their admins/members */}
      <section>
        <div className="section-header" style={{ marginBottom: '12px' }}>
          <h2 style={{ fontSize: '20px', fontFamily: 'Outfit, sans-serif', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Icons.Layers size={20} style={{ color: 'var(--primary)' }} /> Groups
          </h2>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>{groups.length} groups</span>
        </div>

        {groupsQuery.isLoading ? (
          <div style={{ color: 'var(--text-muted)', padding: '12px 0' }}>Loading groups…</div>
        ) : groups.length === 0 ? (
          <div className="empty-state" style={{ padding: '24px' }}>
            <Icons.Layers size={30} className="empty-state-icon" />
            <p className="empty-state-desc" style={{ fontSize: '13px' }}>No groups on this platform.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {groups.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                admins={adminsByGroup[g.id] ?? []}
                expanded={expandedGroupId === g.id}
                onToggle={() => setExpandedGroupId(expandedGroupId === g.id ? null : g.id)}
                onAddAdmin={() => setAssignTarget({ kind: 'group', groupId: g.id, groupName: g.name })}
                onRemoveAdmin={(id) => {
                  if (window.confirm('Remove this group admin? Their group membership is kept.')) {
                    removeGroupAdminMutation.mutate(id);
                  }
                }}
                removingAdmin={removeGroupAdminMutation.isPending}
                onBanner={setBanner}
              />
            ))}
          </div>
        )}
      </section>

      {assignTarget && (
        <AssignAdminModal
          target={assignTarget}
          onClose={() => setAssignTarget(null)}
          onAssigned={(msg) => {
            setBanner({ type: 'success', text: msg });
            invalidatePlatform();
            setAssignTarget(null);
          }}
          onError={(msg) => setBanner({ type: 'error', text: msg })}
        />
      )}
    </div>
  );
};

// ── Group card (expandable: admins + members) ────────────────────────────────

interface GroupCardProps {
  group: ManageableGroup;
  admins: GroupAdminRow[];
  expanded: boolean;
  onToggle: () => void;
  onAddAdmin: () => void;
  onRemoveAdmin: (id: string) => void;
  removingAdmin: boolean;
  onBanner: (b: { type: 'success' | 'error'; text: string }) => void;
}

const GroupCard: React.FC<GroupCardProps> = ({
  group,
  admins,
  expanded,
  onToggle,
  onAddAdmin,
  onRemoveAdmin,
  removingAdmin,
  onBanner,
}) => {
  const queryClient = useQueryClient();

  const membersQuery = useQuery({
    queryKey: queryKeys.adminGroupMembers(group.id),
    queryFn: () => listGroupMembers(group.id),
    enabled: expanded,
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userAccessId: string) => removeGroupMember(group.id, userAccessId),
    onSuccess: () => {
      onBanner({ type: 'success', text: 'Member removed from group.' });
      queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupMembers(group.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(group.platform) });
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to remove member.' }),
  });

  // Active levels for this group — drives the per-member level selector below.
  // Shares the query key with GroupLevelsSection, so the data is fetched once.
  const levelsQuery = useQuery({
    queryKey: queryKeys.adminGroupLevels(group.id),
    queryFn: () => listGroupLevels(group.id),
    enabled: expanded,
  });
  const activeLevels = (levelsQuery.data ?? []).filter((l) => l.isActive);

  const setLevelMutation = useMutation({
    mutationFn: ({ userAccessId, levelId }: { userAccessId: string; levelId: string }) =>
      setGroupMemberLevel(group.id, userAccessId, levelId),
    onSuccess: () => {
      onBanner({ type: 'success', text: 'Member level updated.' });
      queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupMembers(group.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupLevels(group.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(group.platform) });
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to update member level.' }),
  });

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)', overflow: 'hidden' }}>
      {/* Header row */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '16px 20px', cursor: 'pointer' }}
        onClick={onToggle}
      >
        <Icons.ChevronRight
          size={18}
          style={{ color: 'var(--text-light)', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'none' }}
        />
        <div className="group-icon-box" style={{ width: '34px', height: '34px', borderRadius: '8px', flexShrink: 0 }}>
          {(() => {
            const LucideIcon = (Icons as any)[group.icon || 'Layers'] || Icons.Layers;
            return <LucideIcon size={18} style={{ color: group.color || 'var(--primary)' }} />;
          })()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '15px' }}>{group.name}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            {group.adminCount} admin{group.adminCount === 1 ? '' : 's'} · {group.memberCount} member{group.memberCount === 1 ? '' : 's'}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-outline"
          style={{ padding: '5px 12px', fontSize: '12px' }}
          onClick={(e) => {
            e.stopPropagation();
            onAddAdmin();
          }}
        >
          <Icons.UserPlus size={14} /> Add admin
        </button>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '16px 20px', background: 'var(--bg-app)' }}>
          {/* Admins */}
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Group Admins
            </div>
            {admins.length === 0 ? (
              <div style={{ color: 'var(--text-light)', fontSize: '13px' }}>No group admins yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {admins.map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'white', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
                    <Icons.UserCheck size={16} style={{ color: 'var(--primary)' }} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: '13.5px' }}>{cleanName(a.userName)}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '12px', marginLeft: '8px' }}>{a.userEmail}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ padding: '3px 9px', fontSize: '11.5px', borderColor: 'var(--status-rejected-text)', color: 'var(--status-rejected-text)' }}
                      disabled={removingAdmin}
                      onClick={() => onRemoveAdmin(a.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Members */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Members
            </div>
            {membersQuery.isLoading ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading members…</div>
            ) : (membersQuery.data ?? []).length === 0 ? (
              <div style={{ color: 'var(--text-light)', fontSize: '13px' }}>No active members.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {(membersQuery.data ?? []).map((m) => (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'white', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
                    <Icons.User size={16} style={{ color: 'var(--text-light)' }} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: '13.5px' }}>{cleanName(m.userName)}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '12px', marginLeft: '8px' }}>{m.userEmail}</span>
                    </div>
                    {/* Level: shows the member's current level and lets an admin change it.
                        Only rendered for groups that have active levels. */}
                    {activeLevels.length > 0 && (() => {
                      const currentIsActive = activeLevels.some((l) => l.id === m.levelId);
                      return (
                        <select
                          className="form-select"
                          title="Member level"
                          style={{ height: '30px', fontSize: '12px', padding: '2px 8px', width: 'auto', maxWidth: '180px' }}
                          value={currentIsActive ? (m.levelId ?? '') : ''}
                          disabled={setLevelMutation.isPending}
                          onChange={(e) => {
                            const newLevelId = e.target.value;
                            if (!newLevelId || newLevelId === m.levelId) return;
                            setLevelMutation.mutate({ userAccessId: m.id, levelId: newLevelId });
                          }}
                        >
                          {!currentIsActive && (
                            <option value="" disabled>
                              {m.levelName ? `${m.levelName} (inactive)` : '— no level —'}
                            </option>
                          )}
                          {activeLevels.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}{l.permission ? ` · ${l.permission}` : ''}
                            </option>
                          ))}
                        </select>
                      );
                    })()}
                    {m.expiresAt && (
                      <span className="badge badge-pending" style={{ fontSize: '10px' }}>
                        expires {new Date(m.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ padding: '3px 9px', fontSize: '11.5px', borderColor: 'var(--status-rejected-text)', color: 'var(--status-rejected-text)' }}
                      disabled={removeMemberMutation.isPending}
                      onClick={() => {
                        if (window.confirm(`Remove ${cleanName(m.userName)} from ${group.name}? This revokes their access on the platform.`)) {
                          removeMemberMutation.mutate(m.id);
                        }
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Levels (subgroups) */}
          <div style={{ marginTop: '20px', borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
            <GroupLevelsSection group={group} onBanner={onBanner} />
          </div>
        </div>
      )}
    </div>
  );
};

// ── Group levels (subgroups) management ──────────────────────────────────────

const emptyLevelForm: GroupLevelInput = { name: '', slug: '', permission: '', externalGroupId: '', rank: 0 };

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

interface GroupLevelsSectionProps {
  group: ManageableGroup;
  onBanner: (b: { type: 'success' | 'error'; text: string }) => void;
}

const GroupLevelsSection: React.FC<GroupLevelsSectionProps> = ({ group, onBanner }) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<GroupLevelRow | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<GroupLevelInput>(emptyLevelForm);
  // Auto-fill slug from name until the user types a slug by hand.
  const [slugTouched, setSlugTouched] = useState(false);

  const levelsQuery = useQuery({
    queryKey: queryKeys.adminGroupLevels(group.id),
    queryFn: () => listGroupLevels(group.id),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupLevels(group.id) });
    // The request flow reads levels from the public group endpoints.
    queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
    queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(group.slug) });
  };

  const resetForm = () => {
    setEditing(null);
    setShowForm(false);
    setForm(emptyLevelForm);
    setSlugTouched(false);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const body: GroupLevelInput = {
        name: form.name.trim(),
        slug: form.slug.trim(),
        description: form.description?.trim() || undefined,
        permission: form.permission?.trim() || undefined,
        externalGroupId: form.externalGroupId?.trim() || undefined,
        rank: form.rank ?? 0,
      };
      return editing ? updateGroupLevel(group.id, editing.id, body) : createGroupLevel(group.id, body);
    },
    onSuccess: () => {
      onBanner({ type: 'success', text: editing ? 'Level updated.' : 'Level created.' });
      resetForm();
      invalidate();
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to save level.' }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (lvl: GroupLevelRow) => updateGroupLevel(group.id, lvl.id, { isActive: !lvl.isActive }),
    onSuccess: () => {
      onBanner({ type: 'success', text: 'Level updated.' });
      invalidate();
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to update level.' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (lvl: GroupLevelRow) => deleteGroupLevel(group.id, lvl.id),
    onSuccess: (result) => {
      if (result.deleted) {
        onBanner({ type: 'success', text: 'Level removed.' });
      } else if ((result.activeMembers ?? 0) > 0) {
        onBanner({ type: 'success', text: `Level kept active members (${result.activeMembers}), so it was deactivated instead of removed — they keep access until expiry/revoke.` });
      } else {
        onBanner({ type: 'success', text: `Level has ${result.openRequests ?? 0} in-flight request(s), so it was deactivated instead of removed. Resolve those requests, then remove it.` });
      }
      invalidate();
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to remove level.' }),
  });

  const startCreate = () => {
    setEditing(null);
    setForm(emptyLevelForm);
    setSlugTouched(false);
    setShowForm(true);
  };

  const startEdit = (lvl: GroupLevelRow) => {
    setEditing(lvl);
    setForm({
      name: lvl.name,
      slug: lvl.slug,
      description: lvl.description ?? '',
      permission: lvl.permission ?? '',
      externalGroupId: lvl.externalGroupId ?? '',
      rank: lvl.rank,
    });
    setSlugTouched(true);
    setShowForm(true);
  };

  const levels = levelsQuery.data ?? [];
  const canSave = form.name.trim().length > 0 && /^[a-z0-9-]+$/.test(form.slug.trim());

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
          Permission Levels
        </div>
        {!showForm && (
          <button type="button" className="btn btn-outline" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={startCreate}>
            <Icons.Plus size={13} /> Add level
          </button>
        )}
      </div>

      <p style={{ fontSize: '12px', color: 'var(--text-light)', marginBottom: '10px', lineHeight: 1.4 }}>
        Each level is backed by its own {prettyPlatform(group.platform)} group. Leave the External Group ID blank and Hermes creates that group for you; then configure read-only vs write on it in {prettyPlatform(group.platform)}. Hermes routes requesters to the level they pick.
      </p>

      {levelsQuery.isLoading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading levels…</div>
      ) : levels.length === 0 ? (
        <div style={{ color: 'var(--text-light)', fontSize: '13px', marginBottom: '10px' }}>
          No levels. This group is requested directly (no level selection).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
          {levels.map((lvl) => (
            <div
              key={lvl.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                background: 'white',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 12px',
                opacity: lvl.isActive ? 1 : 0.6,
              }}
            >
              <Icons.Layers size={15} style={{ color: lvl.isActive ? 'var(--primary)' : 'var(--text-light)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '13.5px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  {lvl.name}
                  {lvl.permission && (
                    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px' }}>
                      {lvl.permission}
                    </span>
                  )}
                  {!lvl.isActive && (
                    <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-light)' }}>INACTIVE</span>
                  )}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                  ext id: {lvl.externalGroupId || '—'} · rank {lvl.rank} · {lvl.memberCount} member{lvl.memberCount === 1 ? '' : 's'}
                </div>
              </div>
              <button type="button" className="btn btn-outline" style={{ padding: '3px 9px', fontSize: '11.5px' }} onClick={() => startEdit(lvl)}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-outline"
                style={{ padding: '3px 9px', fontSize: '11.5px' }}
                disabled={toggleActiveMutation.isPending}
                onClick={() => toggleActiveMutation.mutate(lvl)}
              >
                {lvl.isActive ? 'Deactivate' : 'Activate'}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                style={{ padding: '3px 9px', fontSize: '11.5px', borderColor: 'var(--status-rejected-text)', color: 'var(--status-rejected-text)' }}
                disabled={deleteMutation.isPending}
                onClick={() => {
                  const msg = lvl.memberCount > 0
                    ? `"${lvl.name}" has ${lvl.memberCount} active member(s). It will be deactivated (not deleted) so they keep access until expiry/revoke. Continue?`
                    : `Remove level "${lvl.name}"?`;
                  if (window.confirm(msg)) deleteMutation.mutate(lvl);
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px', background: 'white' }}>
          <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '10px' }}>
            {editing ? `Edit level: ${editing.name}` : 'New level'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Name</label>
              <input
                className="form-input"
                value={form.name}
                placeholder="Senior Dev"
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
                }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Slug</label>
              <input
                className="form-input"
                value={form.slug}
                placeholder="senior-dev"
                onChange={(e) => {
                  setSlugTouched(true);
                  setForm((f) => ({ ...f, slug: e.target.value }));
                }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Permission label</label>
              <input
                className="form-input"
                value={form.permission ?? ''}
                placeholder="write / read-only"
                onChange={(e) => setForm((f) => ({ ...f, permission: e.target.value }))}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">External Group ID ({prettyPlatform(group.platform)}) — optional</label>
              <input
                className="form-input"
                value={form.externalGroupId ?? ''}
                placeholder={editing ? '1043' : 'leave blank to auto-create'}
                onChange={(e) => setForm((f) => ({ ...f, externalGroupId: e.target.value }))}
              />
              {!editing && (
                <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px', lineHeight: 1.4 }}>
                  Blank → Hermes creates a new {prettyPlatform(group.platform)} group. Paste an ID to link an existing one.
                </div>
              )}
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Rank (higher = more senior)</label>
              <input
                type="number"
                min={0}
                className="form-input"
                value={form.rank ?? 0}
                onChange={(e) => setForm((f) => ({ ...f, rank: Number(e.target.value) }))}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
              <label className="form-label">Description (optional)</label>
              <input
                className="form-input"
                value={form.description ?? ''}
                placeholder="What this level can do"
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          {!/^[a-z0-9-]*$/.test(form.slug) && (
            <div style={{ fontSize: '11px', color: 'var(--status-rejected-text)', marginTop: '6px' }}>
              Slug must be lowercase alphanumeric with hyphens.
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
            <button type="button" className="btn btn-outline" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={resetForm} disabled={saveMutation.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '6px 12px', fontSize: '12px' }}
              disabled={!canSave || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create level'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Assign-admin modal (shared for platform + group) ─────────────────────────

interface AssignAdminModalProps {
  target: AssignTarget;
  onClose: () => void;
  onAssigned: (message: string) => void;
  onError: (message: string) => void;
}

const AssignAdminModal: React.FC<AssignAdminModalProps> = ({ target, onClose, onAssigned, onError }) => {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const debouncedSearch = useDebounced(search, 300);

  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers(debouncedSearch),
    queryFn: () => searchUsers(debouncedSearch),
  });

  const assignMutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Select a user first');
      return target.kind === 'platform'
        ? assignPlatformAdmin(selected.userId, target.platform).then(() => undefined)
        : assignGroupAdmin(selected.userId, target.groupId).then(() => undefined);
    },
    onSuccess: () => {
      const where = target.kind === 'platform' ? `${prettyPlatform(target.platform)} platform admin` : `admin of ${target.groupName}`;
      onAssigned(
        `${cleanName(selected!.userName)} is now a ${where}. The new role takes effect on their next login / token refresh.`,
      );
    },
    onError: (e: any) => onError(e.message || 'Failed to assign admin.'),
  });

  const title = target.kind === 'platform' ? `Add ${prettyPlatform(target.platform)} platform admin` : `Add admin to ${target.groupName}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            <Icons.X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ position: 'relative', marginBottom: '14px' }}>
            <Icons.Search size={16} style={{ position: 'absolute', top: '13px', left: '14px', color: 'var(--text-light)' }} />
            <input
              type="text"
              className="form-input"
              placeholder="Search users by name or email…"
              style={{ paddingLeft: '40px' }}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelected(null);
              }}
              autoFocus
            />
          </div>

          <div style={{ maxHeight: '280px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {usersQuery.isLoading ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '8px' }}>Searching…</div>
            ) : usersQuery.isError ? (
              <div style={{ color: 'var(--status-rejected-text)', fontSize: '13px', padding: '8px' }}>
                {(usersQuery.error as any)?.message || 'Failed to search users.'}
              </div>
            ) : (usersQuery.data ?? []).length === 0 ? (
              <div style={{ color: 'var(--text-light)', fontSize: '13px', padding: '8px' }}>
                {debouncedSearch
                  ? 'No matching users. They must sign in to Hermes once before they can be promoted.'
                  : 'No users yet. Users appear here once they have signed in to Hermes.'}
              </div>
            ) : (
              (usersQuery.data ?? []).map((u) => {
                const isSel = selected?.userId === u.userId;
                return (
                  <button
                    key={u.userId}
                    type="button"
                    onClick={() => setSelected(u)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '10px 12px',
                      border: `1px solid ${isSel ? 'var(--primary)' : 'var(--border)'}`,
                      background: isSel ? 'var(--primary-light)' : 'white',
                      borderRadius: 'var(--radius-md)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <Icons.UserCircle size={20} style={{ color: isSel ? 'var(--primary)' : 'var(--text-light)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{cleanName(u.userName)}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{u.userEmail}</div>
                    </div>
                    {isSel && <Icons.Check size={16} style={{ color: 'var(--primary)' }} />}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={assignMutation.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!selected || assignMutation.isPending}
            onClick={() => assignMutation.mutate()}
          >
            {assignMutation.isPending ? 'Assigning…' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdminManagement;
