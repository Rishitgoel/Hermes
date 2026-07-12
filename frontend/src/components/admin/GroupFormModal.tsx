import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import Modal from '../common/Modal';
import { queryKeys } from '../../lib/queryKeys';
import { isSecretsPlatform } from '../../lib/platforms';
import { prettyPlatform, slugify } from './adminUtils';
import {
  createGroup,
  updateGroup,
  getAwsSecrets,
  type ManageableGroup,
  type CreateGroupInput,
  type UpdateGroupInput,
  type GroupRecord,
} from '../../services/api/admin';

/**
 * Create or edit a group. The form is intentionally minimal: Name + Platform +
 * (optional) backing external group id on create; Name + Description on edit. The
 * slug is auto-derived from the name (never asked) and description is optional.
 * Icon / colour are derived for display (see groupIconName), so they aren't edited
 * here. On edit, slug/platform/externalGroupId are locked (immutable; see admin
 * controller).
 */
interface GroupFormModalProps {
  mode: 'create' | 'edit';
  platforms: string[];
  defaultPlatform?: string | null;
  group?: ManageableGroup;
  onClose: () => void;
  onSaved: (message: string, group: GroupRecord) => void;
  onError: (message: string) => void;
}

export const GroupFormModal: React.FC<GroupFormModalProps> = ({
  mode,
  platforms,
  defaultPlatform,
  group,
  onClose,
  onSaved,
  onError,
}) => {
  const queryClient = useQueryClient();
  const isEdit = mode === 'edit';

  const [name, setName] = useState(group?.name ?? '');
  const [platform, setPlatform] = useState(group?.platform ?? defaultPlatform ?? platforms[0] ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [externalGroupId, setExternalGroupId] = useState('');

  const isSecrets = isSecretsPlatform(platform);
  const [selectedSecrets, setSelectedSecrets] = useState<string[]>([]);
  const [secretsSearch, setSecretsSearch] = useState('');
  const [newPattern, setNewPattern] = useState('');

  // A wildcard/prefix scope ('*' or 'foo*') is not a real AWS secret name — kept
  // separate from the checklist so it's never badged/swept up alongside literal names.
  const isPatternScope = (s: string) => s === '*' || s.endsWith('*');
  const patternSecrets = selectedSecrets.filter(isPatternScope);

  const secretsQuery = useQuery({
    queryKey: ['admin', 'awsSecrets', platform],
    queryFn: () => getAwsSecrets(platform),
    enabled: isSecrets,
  });

  // Slug is never asked — it's derived from the name on create (immutable after).
  const derivedSlug = slugify(name);

  const saveMutation = useMutation({
    mutationFn: (): Promise<GroupRecord> => {
      if (isEdit && group) {
        const body: UpdateGroupInput = {
          name: name.trim(),
          description: description.trim(),
        };
        return updateGroup(group.id, body);
      }
      const body: CreateGroupInput = {
        name: name.trim(),
        slug: derivedSlug,
        description: description.trim() || undefined,
        platform,
        externalGroupId: isSecrets
          ? selectedSecrets.filter(Boolean).join('\n')
          : externalGroupId.trim() || undefined,
      };
      return createGroup(body);
    },
    onSuccess: (record) => {
      const p = isEdit ? group!.platform : platform;
      queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(p) });
      queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
      if (isEdit && group) {
        queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(group.slug) });
      }
      onSaved(isEdit ? `Group "${record.name}" updated.` : `Group "${record.name}" created.`, record);
    },
    onError: (e: any) => onError(e?.message || 'Failed to save group.'),
  });

  // On create the name must yield a valid (non-empty) slug; on edit only the name matters.
  const canSave =
    name.trim().length > 0 && (isEdit || (derivedSlug.length > 0 && platform.length > 0));

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isEdit ? `Edit group: ${group?.name}` : 'New group'}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={saveMutation.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSave || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create group'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Name</label>
          <input
            className="form-input"
            value={name}
            placeholder="Credit Card"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {!isEdit && derivedSlug && (
            <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px' }}>
              Slug: <code>{derivedSlug}</code> (auto-generated; a number is appended if
              it's already taken, then fixed after creation)
            </div>
          )}
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Platform</label>
          <select className="form-select" value={platform} disabled={isEdit} onChange={(e) => setPlatform(e.target.value)}>
            {platforms.map((p) => (
              <option key={p} value={p}>
                {prettyPlatform(p)}
              </option>
            ))}
          </select>
          {isEdit && (
            <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px' }}>
              Platform can't be changed after creation.
            </div>
          )}
        </div>

        {!isEdit && !isSecrets && (
          <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
            <label className="form-label">External Group ID — optional</label>
            <input
              className="form-input"
              value={externalGroupId}
              placeholder="blank → auto-create"
              onChange={(e) => setExternalGroupId(e.target.value)}
            />
            <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px', lineHeight: 1.4 }}>
              Blank → Hermes creates a new {platform ? prettyPlatform(platform) : 'platform'} group. Paste an ID to link an existing one.
            </div>
          </div>
        )}

        {!isEdit && isSecrets && (
          <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
            <label className="form-label">Select AWS Secrets — optional</label>

            <div style={{ marginBottom: '10px', padding: '10px 12px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>
                Wildcard / prefix scope — optional
              </div>
              {patternSecrets.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                  {patternSecrets.map((pattern) => (
                    <span
                      key={pattern}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '3px 8px', borderRadius: '999px', border: '1px solid var(--primary)', fontSize: '12px', fontFamily: 'monospace' }}
                    >
                      {pattern === '*' ? 'Every secret (*)' : pattern}
                      <button
                        type="button"
                        title="Remove this scope"
                        onClick={() => setSelectedSecrets((prev) => prev.filter((s) => s !== pattern))}
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
                  style={{ flex: 1, maxWidth: 220, fontSize: '12px', fontFamily: 'monospace', padding: '4px 8px', border: '1px solid var(--border)', borderRadius: '4px' }}
                />
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ fontSize: '11px', padding: '2px 8px', minHeight: 'auto', borderRadius: '4px' }}
                  onClick={() => {
                    const p = newPattern.trim();
                    if (!p) return;
                    if (p !== '*' && !p.endsWith('*')) {
                      onError('A pattern must be "*" or end with "*" (e.g. investments*).');
                      return;
                    }
                    setSelectedSecrets((prev) => (prev.includes(p) ? prev : [...prev, p]));
                    setNewPattern('');
                  }}
                >
                  Add
                </button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '6px', lineHeight: 1.4 }}>
                Matches every current and future AWS secret starting with the prefix (or literally every secret for &quot;*&quot;) — resolved live, no re-sync needed.
              </div>
            </div>

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
              
              {!secretsQuery.isLoading && !secretsQuery.isError && (secretsQuery.data ?? []).length > 0 && (
                <div style={{ display: 'flex', gap: '8px', padding: '6px 14px', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg-inset)', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ fontSize: '11px', padding: '2px 8px', minHeight: 'auto', borderRadius: '4px' }}
                    onClick={() => {
                      const filtered = (secretsQuery.data ?? []).filter((name) =>
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
                      const filtered = (secretsQuery.data ?? []).filter((name) =>
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
                {secretsQuery.isLoading ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading AWS secrets...</div>
                ) : secretsQuery.isError ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--status-rejected-text)', fontSize: '13px', lineHeight: 1.4 }}>
                    <strong>Failed to load secrets:</strong>
                    <div style={{ marginTop: '4px', fontFamily: 'monospace', fontSize: '12px' }}>
                      {(secretsQuery.error as any)?.response?.data?.message || (secretsQuery.error as any)?.message || 'Check AWS configuration.'}
                    </div>
                  </div>
                ) : (
                  (() => {
                    const filtered = (secretsQuery.data ?? []).filter((name) =>
                      name.toLowerCase().includes(secretsSearch.trim().toLowerCase())
                    );
                    if (filtered.length === 0) {
                      return <div className="admin-secrets-empty">No secrets matched.</div>;
                    }
                    return filtered.map((name) => {
                      const isChecked = selectedSecrets.includes(name);
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
                          <span className="admin-secrets-label">{name}</span>
                        </label>
                      );
                    });
                  })()
                )}
              </div>
            </div>
            
            <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px', lineHeight: 1.4 }}>
              Select the secrets you want members of this group to ingest. You can edit this selection later.
            </div>
          </div>
        )}

        <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
          <label className="form-label">Description — optional</label>
          <input
            className="form-input"
            value={description}
            placeholder="What data / tables this group grants access to"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      {!isEdit && name.trim() && !derivedSlug && (
        <div style={{ fontSize: '11px', color: 'var(--status-rejected-text)', marginTop: '8px' }}>
          Name must contain letters or numbers to generate a slug.
        </div>
      )}
    </Modal>
  );
};

export default GroupFormModal;
