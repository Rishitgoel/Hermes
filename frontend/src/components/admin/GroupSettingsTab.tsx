import React, { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { isSecretsPlatform } from '../../lib/platforms';
import { useToast } from '../../contexts/ToastContext';
import { prettyPlatform, reconcileToast } from './adminUtils';
import ConfirmModal from './ConfirmModal';
import GroupFormModal from './GroupFormModal';
import { updateGroup, deleteGroup, getAwsSecrets, type ManageableGroup } from '../../services/api/admin';

interface GroupSettingsTabProps {
  group: ManageableGroup;
  /** Called after a permanent delete so the drawer can close. */
  onDeleted: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', gap: '12px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
    <div style={{ width: '140px', flexShrink: 0, fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>{label}</div>
    <div style={{ fontSize: '13px', color: 'var(--text-main)', wordBreak: 'break-word' }}>{children}</div>
  </div>
);

export const GroupSettingsTab: React.FC<GroupSettingsTabProps> = ({ group, onDeleted }) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [showEdit, setShowEdit] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmForceDelete, setConfirmForceDelete] = useState(false);

  // Hard delete (incl. history) is only allowed when nobody currently holds active
  // access — otherwise the backend rejects it. memberCount is the active-grant count.
  const hasActiveMembers = group.memberCount > 0;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(group.platform) });
    queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
    queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(group.slug) });
  };

  const archiveMutation = useMutation({
    mutationFn: (next: boolean) => updateGroup(group.id, { isActive: next }),
    onSuccess: (_r, next) => {
      toast.success(next ? 'Group restored — visible in the request flow again.' : 'Group archived — hidden from new requests. Existing members keep access.', { duration: 8000 });
      refresh();
      setConfirmArchive(false);
    },
    onError: (e: any) => toast.error(e.message || 'Failed to update group.'),
  });

  // ZooKeeper groups map to a newline-separated list of znode paths, editable here.
  // Saving reconciles existing members onto the new mapping (server-side).
  const isZk = group.platform === 'zookeeper';
  const isSecrets = isSecretsPlatform(group.platform);

  // Open enrollment: flip the group between "everyone is an implicit member" and the
  // normal request/grant model. Surfaced for Secret Ingestion, where the intent is to
  // let all users file ingestion requests while a few group admins approve.
  const openEnrollmentMutation = useMutation({
    mutationFn: (next: boolean) => updateGroup(group.id, { openEnrollment: next }),
    onSuccess: (_r, next) => {
      toast.success(
        next
          ? 'Open enrollment on — every user can now request Secret Ingestion for this group with no access request.'
          : 'Open enrollment off — access reverts to explicit grants (existing members are unaffected).',
        { duration: 8000 },
      );
      refresh();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to update open enrollment.'),
  });

  const [pathsDraft, setPathsDraft] = useState(group.externalGroupId ?? '');
  // Selected secrets checklist state
  const [selectedSecrets, setSelectedSecrets] = useState<string[]>([]);
  const [secretsSearch, setSecretsSearch] = useState('');
  const [newPattern, setNewPattern] = useState('');

  // A wildcard/prefix scope ('*' or 'foo*') is not a real AWS secret name — it's
  // kept in its own list, editable only via explicit add/remove, so it can never
  // be mistaken for stale "Not in AWS" data or swept up by Select All/Deselect All.
  const isPatternScope = (s: string) => s === '*' || s.endsWith('*');

  const secretsQuery = useQuery({
    queryKey: ['admin', 'awsSecrets', group.platform],
    queryFn: () => getAwsSecrets(group.platform),
    enabled: isSecrets,
  });

  // Resync the drafts when the canonical value changes — after a save refetch or a
  // concurrent admin's edit — so the textarea/checklist never shows a stale value.
  useEffect(() => {
    if (isZk) {
      setPathsDraft(group.externalGroupId ?? '');
    } else if (isSecrets) {
      const initial = (group.externalGroupId ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      setSelectedSecrets(initial);
    }
  }, [group.externalGroupId, isZk, isSecrets]);

  const awsSecretsList = secretsQuery.data ?? [];
  const patternSecrets = React.useMemo(() => selectedSecrets.filter(isPatternScope), [selectedSecrets]);
  const literalSelectedSecrets = React.useMemo(
    () => selectedSecrets.filter((s) => !isPatternScope(s)),
    [selectedSecrets],
  );
  // The "Assigned Secrets" summary row reads straight from the saved group (not the
  // in-progress draft below), so it always reflects what's actually in effect.
  const assignedScopes = React.useMemo(
    () => (group.externalGroupId ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
    [group.externalGroupId],
  );
  // Pattern scopes are deliberately excluded here — they're not AWS secret names,
  // so they never enter the checklist (and can't be badged "Not in AWS" or swept
  // up by Select All/Deselect All).
  const allSecretsOptions = React.useMemo(() => {
    if (!isSecrets) return [];
    const set = new Set([...awsSecretsList, ...literalSelectedSecrets]);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [awsSecretsList, literalSelectedSecrets, isSecrets]);

  const getCleanedSecretsString = (secArray: string[]) => {
    return secArray.map((s) => s.trim()).filter(Boolean).sort().join('\n');
  };

  const pathsDirty = isZk
    ? pathsDraft.trim() !== (group.externalGroupId ?? '').trim()
    : isSecrets
      ? getCleanedSecretsString(selectedSecrets) !== getCleanedSecretsString((group.externalGroupId ?? '').split('\n'))
      : false;

  const reconcileMutation = useMutation({
    mutationFn: (externalGroupIdValue: string) => updateGroup(group.id, { externalGroupId: externalGroupIdValue }),
    onSuccess: (res) => {
      const { ok, message } = reconcileToast(res.reconciliation);
      if (ok) {
        toast.success(message, { duration: 8000 });
      } else {
        toast.error(message, { duration: 9000 });
      }
      refresh();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to save changes.'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteGroup(group.id),
    onSuccess: (result) => {
      if (result.deleted) {
        toast.success(`Group "${group.name}" permanently deleted.`);
        refresh();
        onDeleted();
      } else {
        toast.success(
          `Group has history (${result.accessCount ?? 0} access record(s), ${result.requestCount ?? 0} request(s)), so it was archived instead of deleted.`,
          { duration: 8000 },
        );
        refresh();
        setConfirmDelete(false);
      }
    },
    onError: (e: any) => toast.error(e.message || 'Failed to delete group.'),
  });

  // Permanent delete including history (force) — backend gates on no active members.
  const forceDeleteMutation = useMutation({
    mutationFn: () => deleteGroup(group.id, true),
    onSuccess: () => {
      toast.success(`Group "${group.name}" permanently deleted, including its history.`);
      refresh();
      setConfirmForceDelete(false);
      onDeleted();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to delete group.'),
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div className="admin-section-label">Group Details</div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowEdit(true)}>
          <Icons.Pencil size={14} /> Edit details
        </button>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <Row label="Name">{group.name}</Row>
        <Row label="Description">{group.description || '—'}</Row>
        <Row label="Platform">{prettyPlatform(group.platform)}</Row>
        <Row label="Slug">{group.slug}</Row>
        {!isZk && !isSecrets && <Row label="External Group ID">{group.externalGroupId || '—'}</Row>}
        {isSecrets && (
          <Row label="Assigned Secrets">
            {assignedScopes.length === 0 ? (
              '—'
            ) : (
              assignedScopes.map((scope) => (
                <span
                  key={scope}
                  className={`admin-secrets-assigned-chip ${isPatternScope(scope) ? 'is-pattern' : 'is-literal'}`}
                >
                  {scope === '*' ? 'Every secret (*)' : scope}
                </span>
              ))
            )}
          </Row>
        )}
        <Row label="Tables">{group.tables.length ? group.tables.join(', ') : '—'}</Row>
        <Row label="Status">
          {group.isActive ? (
            <span style={{ color: 'var(--status-approved-text)', fontWeight: 700 }}>Active</span>
          ) : (
            <span style={{ color: 'var(--text-light)', fontWeight: 700 }}>Archived</span>
          )}
        </Row>
        {isSecrets && (
          <Row label="Open enrollment">
            {group.openEnrollment ? (
              <span style={{ color: 'var(--status-approved-text)', fontWeight: 700 }}>On — every user is a member</span>
            ) : (
              <span style={{ color: 'var(--text-light)', fontWeight: 700 }}>Off</span>
            )}
          </Row>
        )}
      </div>

      {/* Open enrollment: makes every Hermes user an implicit member so they can
          self-serve Secret Ingestion requests with no join step; admins still approve. */}
      {isSecrets && (
        <div style={{ marginBottom: '20px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
            <div>
              <div className="admin-section-label" style={{ marginBottom: '4px' }}>Open enrollment</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                When on, <strong>every</strong> Hermes user is automatically a member — anyone can request
                Secret Ingestion for this group's secrets with no access request, while group admins still
                approve each ingestion. New users are covered automatically; no one needs to be added.
              </div>
            </div>
            <button
              type="button"
              className={`btn btn-sm ${group.openEnrollment ? 'btn-primary' : 'btn-outline'}`}
              style={{ flexShrink: 0, minWidth: 64 }}
              disabled={openEnrollmentMutation.isPending}
              onClick={() => openEnrollmentMutation.mutate(!group.openEnrollment)}
            >
              {openEnrollmentMutation.isPending ? '…' : group.openEnrollment ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      )}

      {/* ZooKeeper: editable multi-path mapping. Each line is one znode path with
          optional #perms; saving reconciles current members onto the new set. */}
      {isZk && (
        <div style={{ marginBottom: '20px' }}>
          <div className="admin-section-label" style={{ marginBottom: '6px' }}>ZooKeeper Paths</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4, marginBottom: '8px' }}>
            One znode path per line, optional <code>#perms</code> (c/d/r/w/a) — e.g.{' '}
            <code>/hermes/credit-card#cdrw</code>. Saving grants new paths to every current member and
            removes any you drop.
          </div>
          <textarea
            value={pathsDraft}
            onChange={(e) => setPathsDraft(e.target.value)}
            rows={Math.max(3, pathsDraft.split('\n').length + 1)}
            spellCheck={false}
            placeholder={'/hermes/credit-card#cdrw\n/hermes/shared-config#r'}
            style={{
              width: '100%',
              fontFamily: 'monospace',
              fontSize: '12px',
              padding: '8px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!pathsDirty || reconcileMutation.isPending || pathsDraft.trim().length === 0}
              onClick={() => reconcileMutation.mutate(pathsDraft.trim())}
            >
              {reconcileMutation.isPending ? 'Saving…' : 'Save paths'}
            </button>
          </div>
        </div>
      )}

      {/* Secrets: editable checklist of AWS secrets manager secret names */}
      {isSecrets && (
        <div style={{ marginBottom: '20px' }}>
          <div className="admin-section-label" style={{ marginBottom: '6px' }}>Target AWS Secrets</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4, marginBottom: '8px' }}>
            A member of this group gets access to every secret matched below — the wildcard/prefix
            scopes <strong>and</strong> the individually checked secrets are combined. Saving reconciles
            access for all current members immediately.
          </div>

          <div style={{ marginBottom: '12px', padding: '10px 12px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>
              Wildcard / prefix scopes
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4, marginBottom: '8px' }}>
              Matches secret names live — e.g. <code>investments*</code> grants every secret whose name
              starts with "investments", including ones created later. <code>*</code> grants every secret
              in the account.
            </div>
            {patternSecrets.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                {patternSecrets.map((pattern) => (
                  <span
                    key={pattern}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '3px 8px', borderRadius: '999px', border: '1px solid var(--primary)', fontSize: '11.5px', fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" }}
                  >
                    {pattern === '*' ? 'Every secret (*)' : pattern}
                    <button
                      type="button"
                      title="Remove this scope"
                      onClick={() => {
                        const label = pattern === '*' ? 'every AWS secret' : `every secret matching "${pattern}"`;
                        if (window.confirm(`Remove this scope? It currently grants access to ${label}. This cannot be undone from here — you'd need to re-add it.`)) {
                          setSelectedSecrets((prev) => prev.filter((s) => s !== pattern));
                        }
                      }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}
                    >
                      <Icons.X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="e.g. * or investments*"
                style={{ flex: 1, maxWidth: 220, fontSize: '11.5px', fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace", padding: '4px 8px', border: '1px solid var(--border)', borderRadius: '4px' }}
              />
              <button
                type="button"
                className="btn btn-outline btn-sm"
                style={{ fontSize: '11px', padding: '2px 8px', minHeight: 'auto' }}
                onClick={() => {
                  const p = newPattern.trim();
                  if (!p) return;
                  if (p !== '*' && !p.endsWith('*')) {
                    toast.error('A pattern must be "*" or end with "*" (e.g. investments*).');
                    return;
                  }
                  setSelectedSecrets((prev) => (prev.includes(p) ? prev : [...prev, p]));
                  setNewPattern('');
                }}
              >
                Add
              </button>
            </div>
          </div>

          <div className="admin-secrets-section-heading">Individual secrets</div>
          <div className="admin-secrets-selector">
              <div className="admin-secrets-search-row">
                <Icons.Search size={14} className="search-icon" />
                <input
                  type="text"
                  className="admin-secrets-search-input"
                  placeholder="Filter secrets by name..."
                  value={secretsSearch}
                  onChange={(e) => setSecretsSearch(e.target.value)}
                />
              </div>
              
              {!secretsQuery.isLoading && allSecretsOptions.length > 0 && (
                <div style={{ display: 'flex', gap: '8px', padding: '6px 14px', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg-inset)', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ fontSize: '11px', padding: '2px 8px', minHeight: 'auto', borderRadius: '4px' }}
                    onClick={() => {
                      const filtered = allSecretsOptions.filter((name) =>
                        name.toLowerCase().includes(secretsSearch.trim().toLowerCase())
                      );
                      setSelectedSecrets((prev) => [...new Set([...prev, ...filtered])]);
                    }}
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ fontSize: '11px', padding: '2px 8px', minHeight: 'auto', borderRadius: '4px' }}
                    onClick={() => {
                      const filtered = allSecretsOptions.filter((name) =>
                        name.toLowerCase().includes(secretsSearch.trim().toLowerCase())
                      );
                      setSelectedSecrets((prev) => prev.filter((s) => !filtered.includes(s)));
                    }}
                  >
                    Deselect All
                  </button>
                </div>
              )}
            
            <div className="admin-secrets-list">
              {secretsQuery.isError && (
                <div style={{ margin: '6px', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--status-rejected-text)', backgroundColor: 'var(--status-rejected-bg)', color: 'var(--status-rejected-text)', fontSize: '12px', lineHeight: 1.4 }}>
                  <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                    <Icons.ShieldAlert size={14} />
                    Failed to query AWS Secrets Manager:
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all' }}>
                    {(secretsQuery.error as any)?.response?.data?.message || (secretsQuery.error as any)?.message || 'Check AWS configuration.'}
                  </div>
                </div>
              )}

              {secretsQuery.isLoading ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading AWS secrets...</div>
              ) : (
                (() => {
                  const filtered = allSecretsOptions.filter((name) =>
                    name.toLowerCase().includes(secretsSearch.trim().toLowerCase())
                  );
                  if (filtered.length === 0) {
                    return <div className="admin-secrets-empty">No secrets matched.</div>;
                  }
                  return filtered.map((name) => {
                    const isChecked = selectedSecrets.includes(name);
                    const isPresentInAws = awsSecretsList.includes(name);
                    return (
                      <label key={name} className="admin-secrets-item">
                        <input
                          type="checkbox"
                          className="admin-secrets-checkbox"
                          checked={isChecked}
                          onChange={() => {
                            setSelectedSecrets((prev) =>
                              isChecked ? prev.filter((s) => s !== name) : [...prev, name]
                            );
                          }}
                        />
                        <span className="admin-secrets-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{name}</span>
                          {!isPresentInAws && (
                            <span className="admin-secrets-not-in-aws-badge" title="Selected here but no longer found in AWS Secrets Manager">
                              Not in AWS
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  });
                })()
              )}
            </div>
          </div>
          
          {selectedSecrets.length === 0 && (
            <div style={{ fontSize: '12px', color: 'var(--status-rejected-text)', marginTop: '8px', lineHeight: 1.4 }}>
              Select at least one secret or wildcard scope before saving — a group can't be left with no
              access target. To remove this group's access entirely, archive or delete the group instead.
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!pathsDirty || reconcileMutation.isPending || selectedSecrets.length === 0}
              onClick={() => reconcileMutation.mutate(selectedSecrets.join('\n'))}
            >
              {reconcileMutation.isPending ? 'Saving…' : 'Save secrets'}
            </button>
          </div>
        </div>
      )}

      {/* Danger zone: archive/restore + permanent delete */}
      <div style={{ border: '1px solid var(--status-rejected-text)', borderRadius: 'var(--radius-md)', padding: '14px', background: 'var(--status-rejected-bg)' }}>
        <div className="admin-section-label" style={{ color: 'var(--status-rejected-text)', marginBottom: '8px' }}>Danger Zone</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {group.isActive
                ? 'Archiving hides this group from new requests. Existing members keep access until expiry/revoke.'
                : 'This group is archived. Restore it to make it requestable again.'}
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ flexShrink: 0 }}
              disabled={archiveMutation.isPending}
              onClick={() => (group.isActive ? setConfirmArchive(true) : archiveMutation.mutate(true))}
            >
              {group.isActive ? 'Archive group' : 'Restore group'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              Permanently delete. Only possible if the group has never had a member or request; otherwise it archives.
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ flexShrink: 0, color: 'white', background: 'var(--status-rejected-text)', borderColor: 'var(--status-rejected-text)' }}
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete permanently
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              Permanently delete <strong>including its history</strong> (access + request records).
              {hasActiveMembers
                ? ` Blocked: ${group.memberCount} active member(s) — revoke their access first.`
                : ' Audit log entries are kept. This cannot be undone.'}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ flexShrink: 0, color: 'white', background: 'var(--status-rejected-text)', borderColor: 'var(--status-rejected-text)' }}
              disabled={forceDeleteMutation.isPending || hasActiveMembers}
              title={hasActiveMembers ? 'Revoke all active members before deleting.' : undefined}
              onClick={() => setConfirmForceDelete(true)}
            >
              Delete with history
            </button>
          </div>
        </div>
      </div>

      {showEdit && (
        <GroupFormModal
          mode="edit"
          platforms={[group.platform]}
          group={group}
          onClose={() => setShowEdit(false)}
          onSaved={(msg) => {
            toast.success(msg);
            setShowEdit(false);
          }}
          onError={(msg) => toast.error(msg)}
        />
      )}

      <ConfirmModal
        isOpen={confirmArchive}
        title="Archive group"
        confirmLabel="Archive"
        loading={archiveMutation.isPending}
        message={`Archive "${group.name}"? It will be hidden from new access requests. Existing members keep their access until it expires or is revoked.`}
        onConfirm={() => archiveMutation.mutate(false)}
        onClose={() => setConfirmArchive(false)}
      />

      <ConfirmModal
        isOpen={confirmDelete}
        title="Delete group permanently"
        danger
        confirmLabel="Delete"
        loading={deleteMutation.isPending}
        message={`Permanently delete "${group.name}" and its backing platform group? If the group has any history (members or requests, past or present) it will be archived instead. This cannot be undone.`}
        onConfirm={() => deleteMutation.mutate()}
        onClose={() => setConfirmDelete(false)}
      />

      <ConfirmModal
        isOpen={confirmForceDelete}
        title="Delete group with history"
        danger
        confirmLabel="Delete with history"
        loading={forceDeleteMutation.isPending}
        message={`Permanently delete "${group.name}", its backing platform group, and ALL of its access + request history? This is only allowed because no one currently holds active access. Audit log entries are preserved. This cannot be undone.`}
        onConfirm={() => forceDeleteMutation.mutate()}
        onClose={() => setConfirmForceDelete(false)}
      />
    </div>
  );
};

export default GroupSettingsTab;
