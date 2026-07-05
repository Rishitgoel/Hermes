import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import LoadingSpinner from '../components/common/LoadingSpinner';
import SectionHeader from '../components/common/SectionHeader';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { useToast } from '../contexts/ToastContext';
import { queryKeys } from '../lib/queryKeys';
import {
  getSecretScope,
  listSecretKeys,
  listIngestionRequests,
  submitIngestionRequest,
  type SecretIngestionRequest,
} from '../services/api/secretsApi';

const STATUS_BADGE: Record<SecretIngestionRequest['status'], string> = {
  PENDING: 'badge-pending',
  APPLYING: 'badge-pending',
  APPLIED: 'badge-active',
  PARTIALLY_APPLIED: 'badge-pending',
  APPLY_FAILED: 'badge-danger',
  REJECTED: 'badge-danger',
};

interface DraftEntry {
  key: string;
  value: string;
}

export const SecretIngestion: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [selectedSecret, setSelectedSecret] = useState<string>('');
  // In-memory only — these hold real, unsubmitted secret values, so they are
  // deliberately NOT persisted to localStorage (would sit there in plaintext
  // indefinitely, unscoped by user). Lost on refresh/navigation by design.
  const [drafts, setDrafts] = useState<Record<string, DraftEntry[]>>({});

  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [justification, setJustification] = useState('');
  const [keySearch, setKeySearch] = useState('');
  const [secretPrefix, setSecretPrefix] = useState('');

  // ── Queries ───────────────────────────────────────────────────────────────────
  const { data: scope = [], isLoading: scopeLoading } = useQuery({
    queryKey: queryKeys.secretsScope(),
    queryFn: getSecretScope,
  });

  const { data: existingKeysData, isLoading: keysLoading } = useQuery({
    queryKey: queryKeys.secretKeys(selectedSecret),
    queryFn: () => listSecretKeys(selectedSecret),
    enabled: !!selectedSecret,
  });

  const { data: myRequests = [] } = useQuery({
    queryKey: queryKeys.secretIngestionRequests('mine'),
    queryFn: () => listIngestionRequests('mine'),
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: () =>
      submitIngestionRequest({
        secretName: selectedSecret,
        justification: justification.trim() || undefined,
        entries: currentDrafts,
      }),
    onSuccess: () => {
      toast.success('Secret ingestion request submitted for approval.');
      setDrafts((prev) => {
        const copy = { ...prev };
        delete copy[selectedSecret];
        return copy;
      });
      setJustification('');
      queryClient.invalidateQueries({ queryKey: queryKeys.secretIngestionRequests('mine') });
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to submit request.'),
  });

  // ── Derived ───────────────────────────────────────────────────────────────────
  const secretOptions = useMemo(() => {
    const list: { secretName: string; groupName: string }[] = [];
    for (const entry of scope) {
      for (const name of entry.secretNames) {
        list.push({ secretName: name, groupName: entry.groupName });
      }
    }
    return list.sort((a, b) => a.secretName.localeCompare(b.secretName));
  }, [scope]);

  // Stage 1 (pre-filter): keep only secrets whose name STARTS WITH the prefix. This is the
  // exact set handed to the selector — a prefix like "prod" must strictly exclude everything
  // else (e.g. payment/stripe), even the currently-selected secret.
  const prefixFilteredOptions = useMemo(() => {
    const p = secretPrefix.trim().toLowerCase();
    if (!p) return secretOptions;
    return secretOptions.filter((o) => o.secretName.toLowerCase().startsWith(p));
  }, [secretOptions, secretPrefix]);

  // Set default selection if empty
  React.useEffect(() => {
    if (!selectedSecret && secretOptions.length > 0) {
      setSelectedSecret(secretOptions[0].secretName);
    }
  }, [secretOptions, selectedSecret]);

  // Reset key search when user switches secrets
  React.useEffect(() => {
    setKeySearch('');
  }, [selectedSecret]);

  const currentDrafts = drafts[selectedSecret] || [];

  const handleAddDraft = (e: React.FormEvent) => {
    e.preventDefault();
    const keyTrimmed = newKey.trim();
    if (!keyTrimmed) {
      toast.error('Key name cannot be empty');
      return;
    }
    if (currentDrafts.some((d) => d.key === keyTrimmed)) {
      toast.error('Key already exists in draft list');
      return;
    }
    const newEntry: DraftEntry = { key: keyTrimmed, value: newValue };
    setDrafts((prev) => ({
      ...prev,
      [selectedSecret]: [...(prev[selectedSecret] || []), newEntry],
    }));
    setNewKey('');
    setNewValue('');
  };

  const handleRemoveDraft = (keyToRemove: string) => {
    setDrafts((prev) => {
      const items = (prev[selectedSecret] || []).filter((d) => d.key !== keyToRemove);
      return {
        ...prev,
        [selectedSecret]: items,
      };
    });
  };

  const handleDiscardAll = () => {
    setDrafts((prev) => {
      const copy = { ...prev };
      delete copy[selectedSecret];
      return copy;
    });
  };

  if (scopeLoading) return <LoadingSpinner />;

  return (
    <div>
      <SectionHeader
        title="Secret Ingestion"
        icon={<Icons.KeyRound size={18} />}
        meta="Propose secret key-value pairs to merge into AWS Secrets Manager"
      />

      {secretOptions.length === 0 ? (
        <div className="empty-state">
          <Icons.Key size={40} className="empty-state-icon" />
          <p className="empty-state-desc">You don't have access to any AWS secrets yet.</p>
        </div>
      ) : (
        <div className="table-container" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-group">
              <label className="form-label" style={{ fontWeight: 600 }}>Target AWS Secret</label>
              {/* Stage 1 — prefix pre-filter: narrows to secrets whose name starts with the text. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--bg-card)', maxWidth: 400, marginBottom: 8 }}>
                <Icons.Filter size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <input
                  type="text"
                  value={secretPrefix}
                  onChange={(e) => setSecretPrefix(e.target.value)}
                  placeholder="Filter by prefix (e.g. investments)…"
                  style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 12, color: 'var(--text-main)', fontFamily: 'monospace' }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {prefixFilteredOptions.length} / {secretOptions.length}
                </span>
                {secretPrefix && (
                  <button
                    type="button"
                    onClick={() => setSecretPrefix('')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1, display: 'flex' }}
                    title="Clear prefix filter"
                  >
                    <Icons.X size={13} />
                  </button>
                )}
              </div>
              {/* Stage 2 — the selector's own search does a substring match within the pre-filtered set. */}
              <SearchableSelect
                options={prefixFilteredOptions.map((opt) => ({
                  value: opt.secretName,
                  label: opt.secretName,
                  groupName: opt.groupName,
                }))}
                value={selectedSecret}
                onChange={(val) => setSelectedSecret(val)}
                style={{ maxWidth: 400 }}
              />
            </div>

            {selectedSecret && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 12 }}>
                {/* Left: Existing Secret Info */}
                <div>
                  <h4 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-main)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icons.ShieldAlert size={15} style={{ color: 'var(--primary)' }} />
                    Existing Keys
                  </h4>
                  {keysLoading ? (
                    <LoadingSpinner />
                  ) : !existingKeysData?.exists ? (
                    <div style={{ padding: 12, borderRadius: 6, border: '1px dashed var(--border)', color: 'var(--text-muted)', fontSize: 13 }}>
                      Secret does not exist in AWS yet. Ingestion will create it.
                    </div>
                  ) : existingKeysData.keys.length === 0 ? (
                    <div style={{ padding: 12, borderRadius: 6, border: '1px dashed var(--border)', color: 'var(--text-muted)', fontSize: 13 }}>
                      Secret exists but contains no keys.
                    </div>
                  ) : (() => {
                    const filteredKeys = existingKeysData.keys.filter((k) =>
                      k.toLowerCase().includes(keySearch.trim().toLowerCase())
                    );
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {/* Search bar — standalone like Target AWS Secret selector */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--bg-card)' }}>
                          <Icons.Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                          <input
                            type="text"
                            value={keySearch}
                            onChange={(e) => setKeySearch(e.target.value)}
                            placeholder="Search keys…"
                            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 12, color: 'var(--text-main)', fontFamily: 'monospace' }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                            {filteredKeys.length} / {existingKeysData.keys.length}
                          </span>
                          {keySearch && (
                            <button
                              type="button"
                              onClick={() => setKeySearch('')}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1, display: 'flex' }}
                              title="Clear search"
                            >
                              <Icons.X size={13} />
                            </button>
                          )}
                        </div>
                        {/* Keys table — its own bordered container */}
                        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                          {filteredKeys.length === 0 ? (
                            <div style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                              No keys matched &ldquo;{keySearch}&rdquo;
                            </div>
                          ) : (
                            <table className="hermes-table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th>Key</th>
                                  <th style={{ width: 100 }}>Value</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filteredKeys.map((k) => (
                                  <tr key={k}>
                                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{k}</td>
                                    <td style={{ color: 'var(--text-light)', fontSize: 12 }}>••••••••</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Right: Stage New Ingestions */}
                <div>
                  <h4 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-main)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icons.PlusCircle size={15} style={{ color: 'var(--primary)' }} />
                    Add Key-Value Entry
                  </h4>
                  <form onSubmit={handleAddDraft} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: '1px solid var(--border)', borderRadius: 6 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" style={{ fontSize: 12 }}>Key Name</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="e.g. STRIPE_API_KEY"
                        style={{ fontFamily: 'monospace', fontSize: 12 }}
                        value={newKey}
                        onChange={(e) => setNewKey(e.target.value)}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" style={{ fontSize: 12 }}>Secret Value</label>
                      <textarea
                        className="form-textarea"
                        placeholder="Secret value payload"
                        rows={3}
                        style={{ fontFamily: 'monospace', fontSize: 12 }}
                        value={newValue}
                        onChange={(e) => setNewValue(e.target.value)}
                      />
                    </div>
                    <button type="submit" className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-end', marginTop: 4 }}>
                      Stage Entry
                    </button>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Draft cart + submission */}
      {selectedSecret && currentDrafts.length > 0 && (
        <div className="bulk-request-panel" style={{ marginTop: 28 }}>
          <div className="bulk-request-header">
            <div className="bulk-request-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.ListChecks size={18} style={{ color: 'var(--primary)' }} />
              {currentDrafts.length} staged entry/entries for <code>{selectedSecret}</code>
            </div>
            <button type="button" className="btn btn-outline btn-sm" onClick={handleDiscardAll}>
              Discard all
            </button>
          </div>

          <div style={{ padding: '0 4px' }}>
            {currentDrafts.map((d) => {
              const overwrites = existingKeysData?.keys.includes(d.key) || false;
              return (
                <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className="badge badge-pending badge-sm" style={{ textTransform: 'uppercase', fontSize: 10, fontWeight: 700 }}>ADD</span>
                  <code style={{ fontSize: 12, color: 'var(--text-main)', fontWeight: 600 }}>
                    {d.key}
                  </code>
                  {overwrites && (
                    <span className="badge badge-danger badge-sm" style={{ fontSize: 9, textTransform: 'uppercase' }}>
                      Overwrites existing key
                    </span>
                  )}
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
                    = {d.value.length > 40 ? `${d.value.slice(0, 40)}...` : d.value}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => handleRemoveDraft(d.key)} title="Remove" style={{ flexShrink: 0 }}>
                    <Icons.X size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="bulk-request-body" style={{ gridTemplateColumns: '1fr', gap: 12, marginTop: 12 }}>
            <div className="form-group form-row" style={{ marginBottom: 0 }}>
              <label className="form-label">Justification</label>
              <textarea
                className="form-textarea"
                placeholder="Why is this ingestion request needed? (optional)"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
              />
            </div>
          </div>

          <div className="bulk-request-footer">
            <span style={{ marginRight: 'auto', fontSize: 13, color: 'var(--text-muted)' }}>
              Requires admin approval. Merges approved keys; leaves unmentioned keys intact.
            </span>
            <button
              type="button"
              className="btn btn-primary"
              style={{ gap: 6 }}
              disabled={submitMutation.isPending}
              onClick={() => submitMutation.mutate()}
            >
              {submitMutation.isPending ? <Icons.Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Icons.Send size={16} />}
              Submit Ingestion Request
            </button>
          </div>
        </div>
      )}

      {/* My Ingestion Requests */}
      <div style={{ marginTop: 36 }}>
        <SectionHeader title="My Ingestion Requests" icon={<Icons.FileClock size={18} />} meta={`${myRequests.length} total`} />
        {myRequests.length === 0 ? (
          <div className="empty-state">
            <Icons.FileClock size={40} className="empty-state-icon" />
            <p className="empty-state-desc">You haven't submitted any secret ingestion requests yet.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="hermes-table">
              <thead>
                <tr>
                  <th>Secret</th>
                  <th>Keys Info</th>
                  <th style={{ width: 140 }}>Status</th>
                  <th style={{ width: 180 }}>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {myRequests.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 13 }}>{r.secretName}</td>
                    <td>
                      <details>
                        <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>
                          {r.entries.length} key(s)
                        </summary>
                        <div style={{ marginTop: 8 }}>
                          {r.entries.map((entry, idx) => (
                            <div key={idx} style={{ fontSize: 12, padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                              {entry.decision === 'APPROVED' && entry.applied && (
                                <Icons.Check size={12} style={{ color: '#16a34a' }} />
                              )}
                              {entry.decision === 'APPROVED' && !entry.applied && (
                                <Icons.AlertTriangle size={12} style={{ color: '#dc2626' }} />
                              )}
                              {entry.decision === 'REJECTED' && (
                                <Icons.X size={12} style={{ color: '#dc2626' }} />
                              )}
                              <code style={{ fontWeight: 600 }}>{entry.key}</code>
                              <span style={{ color: 'var(--text-light)' }}>
                                {entry.value === null || entry.value === undefined ? (
                                  <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>(Redacted value)</span>
                                ) : (
                                  `= ${entry.value.length > 20 ? `${entry.value.slice(0, 20)}...` : entry.value}`
                                )}
                              </span>
                              {entry.error && <span style={{ color: '#dc2626' }}>· Error: {entry.error}</span>}
                            </div>
                          ))}
                          {r.justification && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>
                              "Justification: {r.justification}"
                            </div>
                          )}
                          {r.reviewerName && (
                            <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>
                              Reviewed by {r.reviewerName}
                              {r.reviewNote && ` with note: "${r.reviewNote}"`}
                            </div>
                          )}
                          {r.applyError && (
                            <div style={{ fontSize: 12, color: '#dc2626', marginTop: 4 }}>
                              Error: {r.applyError}
                            </div>
                          )}
                        </div>
                      </details>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[r.status]} badge-sm`}>{r.status}</span>
                    </td>
                    <td style={{ color: 'var(--text-light)', fontSize: 13 }}>
                      {new Date(r.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
