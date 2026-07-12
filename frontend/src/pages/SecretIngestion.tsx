import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import LoadingSpinner from '../components/common/LoadingSpinner';
import SectionHeader from '../components/common/SectionHeader';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { useToast } from '../contexts/ToastContext';
import { queryKeys } from '../lib/queryKeys';
import { envBg, envOf, formatTargetPath, INFRA_STATE_META } from '../lib/infraTargetFormat';
import {
  getSecretScope,
  listSecretKeys,
  listIngestionRequests,
  submitIngestionRequest,
  previewInfraTargets,
  listSecretsInstances,
  type SecretIngestionRequest,
  type InfraTargetSelection,
} from '../services/api/secretsApi';

/** Stable empty-set reference for the "no keys excluded for this path yet" default. */
const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

const STATUS_BADGE: Record<SecretIngestionRequest['status'], string> = {
  PENDING: 'badge-pending',
  APPLYING: 'badge-pending',
  APPLIED: 'badge-active',
  // Terminal-but-mixed — amber with a border, distinct from in-flight PENDING.
  PARTIALLY_APPLIED: 'badge-warning',
  APPLY_FAILED: 'badge-danger',
  REJECTED: 'badge-danger',
};

interface DraftEntry {
  key: string;
  value: string;
}

/** A secret value shown masked by default, with an eye toggle to reveal (truncated). */
const MaskedValue: React.FC<{ value: string; maxLen?: number }> = ({ value, maxLen = 40 }) => {
  const [show, setShow] = useState(false);
  const display = value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {show ? display : '••••••••'}
      </span>
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        title={show ? 'Hide value' : 'Reveal value'}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1, display: 'flex', flexShrink: 0 }}
      >
        {show ? <Icons.EyeOff size={13} /> : <Icons.Eye size={13} />}
      </button>
    </span>
  );
};

/** Deployment-PR state cell for a request: a state chip plus a link to the GitHub PR. */
const InfraPrCell: React.FC<{ request: SecretIngestionRequest }> = ({ request }) => {
  const state = request.infraSyncState;
  if (!state) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const meta = INFRA_STATE_META[state] ?? { label: state, cls: 'badge-pending' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className={`badge ${meta.cls} badge-sm`} title={request.infraSyncNote ?? undefined}>{meta.label}</span>
      {request.infraPrUrl && (
        <a href={request.infraPrUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--primary)', fontSize: 12 }}>
          <Icons.ExternalLink size={12} />
          {request.infraPrNumber ? `#${request.infraPrNumber}` : 'View'}
        </a>
      )}
    </span>
  );
};

export const SecretIngestion: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();

  // The selected Secret Ingestion instance (AWS account) — prod ("secrets") by default; the
  // chooser below switches to "secrets-sandbox" when configured. Every query/mutation is scoped
  // to it, so the whole page reflects one account at a time.
  const [selectedPlatform, setSelectedPlatform] = useState<string>('secrets');

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
  // infra-deployment target selection (per-request): files the requester un-ticks, and
  // extra files they add by path for a name-mismatch the auto-scan couldn't find.
  const [excludedTargetPaths, setExcludedTargetPaths] = useState<Set<string>>(new Set());
  const [manualTargets, setManualTargets] = useState<{ path: string }[]>([]);
  const [manualPath, setManualPath] = useState('');
  const [showAddFile, setShowAddFile] = useState(false);
  // Per-file key narrowing: path -> set of keys the requester excluded from THAT file only
  // (the rest of the request is unaffected). Lets them keep a file in the PR while dropping
  // one of its keys, instead of the whole file being all-or-nothing.
  const [excludedKeysByPath, setExcludedKeysByPath] = useState<Record<string, Set<string>>>({});

  // ── Queries ───────────────────────────────────────────────────────────────────
  // The configured instances (prod + any sandbox). The chooser only renders when >1.
  const { data: instances = [] } = useQuery({
    queryKey: queryKeys.secretsInstances(),
    queryFn: listSecretsInstances,
  });

  // Keep the selection valid once instances load (e.g. sandbox-only deployments have no "secrets").
  React.useEffect(() => {
    if (instances.length === 0) return;
    if (!instances.some((i) => i.key === selectedPlatform)) {
      setSelectedPlatform(instances[0].key);
    }
  }, [instances, selectedPlatform]);

  // Switching instance = a different AWS account: drop the selected secret, prefix filter, and
  // any unsubmitted drafts (their values belong to the previous account and must not carry over).
  React.useEffect(() => {
    setSelectedSecret('');
    setSecretPrefix('');
    setDrafts({});
  }, [selectedPlatform]);

  const { data: scope = [], isLoading: scopeLoading } = useQuery({
    queryKey: queryKeys.secretsScope(selectedPlatform),
    queryFn: () => getSecretScope(selectedPlatform),
  });

  const { data: existingKeysData, isLoading: keysLoading } = useQuery({
    queryKey: queryKeys.secretKeys(selectedPlatform, selectedSecret),
    queryFn: () => listSecretKeys(selectedSecret, selectedPlatform),
    enabled: !!selectedSecret,
  });

  const { data: myRequests = [] } = useQuery({
    queryKey: queryKeys.secretIngestionRequests('mine', selectedPlatform),
    queryFn: () => listIngestionRequests('mine', selectedPlatform),
    // The infra-deployment PR opens asynchronously after submit — poll briefly so its
    // link/state surfaces here without a manual refresh.
    refetchInterval: 12000,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: () =>
      submitIngestionRequest({
        platform: selectedPlatform,
        secretName: selectedSecret,
        justification: justification.trim() || undefined,
        entries: currentDrafts,
        // Send the selection verbatim once the preview has resolved — an empty array means
        // "no files → no PR" (update-only) and must be honored, not fall back to auto-resolve.
        // EXCEPTION: if the selection is empty only because every consumer was unmatched (the
        // scan found the secret referenced but couldn't parse the file's key-list structure),
        // sending [] would tell the backend "requester chose no files" and produce a false
        // "no manifest changes" note — send undefined instead so the backend auto-resolves and
        // reports the real "register manually" note for those files.
        infraTargets: infraPreview
          ? (selectedInfraTargets.length === 0 && unmatchedTargets.length > 0 ? undefined : selectedInfraTargets)
          : undefined,
      }),
    onSuccess: () => {
      toast.success('Request submitted. A deployment PR will appear under “My Ingestion Requests”.');
      setDrafts((prev) => {
        const copy = { ...prev };
        delete copy[selectedSecret];
        return copy;
      });
      setJustification('');
      setExcludedTargetPaths(new Set());
      setManualTargets([]);
      setExcludedKeysByPath({});
      queryClient.invalidateQueries({ queryKey: queryKeys.secretIngestionRequests('mine', selectedPlatform) });
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

  // Keep the selection inside the (possibly prefix-filtered) option set: default to the
  // first option, and reselect when the prefix filter excludes the current selection —
  // otherwise the form below keeps silently operating on a secret the selector no longer
  // shows. Clears when the filter matches nothing.
  React.useEffect(() => {
    if (prefixFilteredOptions.some((o) => o.secretName === selectedSecret)) return;
    setSelectedSecret(prefixFilteredOptions[0]?.secretName ?? '');
  }, [prefixFilteredOptions, selectedSecret]);

  // Reset key search when user switches secrets
  React.useEffect(() => {
    setKeySearch('');
  }, [selectedSecret]);

  const currentDrafts = useMemo(() => drafts[selectedSecret] || [], [drafts, selectedSecret]);
  const draftKeys = useMemo(() => currentDrafts.map((d) => d.key), [currentDrafts]);

  // ── infra-deployment target preview ────────────────────────────────────────────
  const { data: infraPreview, isFetching: infraLoading } = useQuery({
    queryKey: queryKeys.secretInfraPreview(selectedPlatform, selectedSecret, draftKeys),
    queryFn: () => previewInfraTargets(selectedSecret, draftKeys, selectedPlatform),
    enabled: !!selectedSecret && draftKeys.length > 0,
  });
  const previewTargets = useMemo(() => infraPreview?.targets ?? [], [infraPreview]);
  // A file only needs the PR when it's MISSING one of the keys (a new key name). A file that
  // already lists every key just takes the value update in AWS — no manifest change.
  const newTargets = useMemo(() => previewTargets.filter((t) => t.keysToAdd.length > 0), [previewTargets]);
  // Referenced the secret but the scan couldn't recognize its structure — the key was NOT
  // registered here. Must never be shown as "up to date" (that's the exact bug this fixes):
  // the requester needs to know this file still needs manual attention.
  const unmatchedTargets = useMemo(() => previewTargets.filter((t) => t.unmatched), [previewTargets]);
  const upToDateTargets = useMemo(
    () => previewTargets.filter((t) => t.keysToAdd.length === 0 && !t.unmatched),
    [previewTargets],
  );

  // Reset the file selection whenever the secret changes.
  React.useEffect(() => {
    setExcludedTargetPaths(new Set());
    setManualTargets([]);
    setManualPath('');
    setShowAddFile(false);
    setExcludedKeysByPath({});
  }, [selectedSecret]);

  // The candidate key list offered for a manually-added file — we have no live diff for an
  // arbitrary path, so offer every key the scan found missing anywhere, falling back to
  // every drafted key if the scan found nothing (e.g. this secret matches no manifest at all).
  const allCandidateKeys = useMemo(() => {
    const fromScan = [...new Set(newTargets.flatMap((t) => t.keysToAdd))];
    return fromScan.length > 0 ? fromScan : draftKeys;
  }, [newTargets, draftKeys]);

  // The requester's final selection sent on submit: auto-detected files they kept, plus any
  // they added by hand (de-duped by path). Empty ⇒ let the backend auto-resolve at PR time.
  const selectedInfraTargets: InfraTargetSelection[] = useMemo(() => {
    const byPath = new Map<string, InfraTargetSelection>();
    // Only files that actually gain a new key count toward the PR.
    for (const t of newTargets) {
      if (excludedTargetPaths.has(t.path)) continue;
      const excluded = excludedKeysByPath[t.path];
      const keys = excluded && excluded.size > 0 ? t.keysToAdd.filter((k) => !excluded.has(k)) : undefined;
      if (keys && keys.length === 0) continue; // every key unticked ⇒ same as excluding the file
      byPath.set(t.path, { path: t.path, manifestRef: t.manifestRef, format: t.format, keys, env: t.env });
    }
    for (const m of manualTargets) {
      if (byPath.has(m.path)) continue;
      const excluded = excludedKeysByPath[m.path];
      const keys = excluded && excluded.size > 0 ? allCandidateKeys.filter((k) => !excluded.has(k)) : undefined;
      if (keys && keys.length === 0) continue;
      // No backend-resolved env for a hand-added path (the scan never saw it) — derive it
      // client-side with the same shared envOf() the review queue uses as its fallback.
      byPath.set(m.path, { path: m.path, keys, env: envOf(m.path) });
    }
    return [...byPath.values()];
  }, [newTargets, excludedTargetPaths, excludedKeysByPath, manualTargets, allCandidateKeys]);

  const toggleTarget = (path: string) =>
    setExcludedTargetPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleKeyForPath = (path: string, key: string) =>
    setExcludedKeysByPath((prev) => {
      const set = new Set(prev[path] || []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...prev, [path]: set };
    });

  const addManualTarget = () => {
    const p = manualPath.trim();
    if (!p) return;
    if (previewTargets.some((t) => t.path === p) || manualTargets.some((m) => m.path === p)) {
      toast.error('That file is already in the list.');
      return;
    }
    setManualTargets((prev) => [...prev, { path: p }]);
    setManualPath('');
  };

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

  // Instance chooser (prod vs sandbox) — only shown when more than one instance is configured.
  const platformChooser = instances.length > 1 && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Instance</span>
      <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        {instances.map((inst) => {
          const active = inst.key === selectedPlatform;
          return (
            <button
              key={inst.key}
              type="button"
              onClick={() => setSelectedPlatform(inst.key)}
              style={{
                padding: '7px 16px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                border: 'none',
                background: active ? 'var(--primary)' : 'transparent',
                color: active ? '#fff' : 'var(--text-muted)',
                transition: 'var(--transition)',
              }}
            >
              {inst.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (scopeLoading) {
    return (
      <div>
        <SectionHeader
          title="Secret Ingestion"
          icon={<Icons.KeyRound size={18} />}
          meta="Propose secret key-value pairs to merge into AWS Secrets Manager"
        />
        {platformChooser}
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title="Secret Ingestion"
        icon={<Icons.KeyRound size={18} />}
        meta="Propose secret key-value pairs to merge into AWS Secrets Manager"
      />

      {platformChooser}

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
                  ) : existingKeysData.keyValueFormat === false ? (
                    <div style={{ padding: 12, borderRadius: 6, border: '1px dashed #dc2626', color: '#dc2626', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Icons.AlertTriangle size={15} style={{ flexShrink: 0 }} />
                      This secret exists but its payload is not key-value JSON — Hermes cannot list or merge keys into it.
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
              const kind = overwrites ? 'UPDATE' : 'ADD';
              const kindBg = overwrites ? '#d97706' : '#16a34a';
              return (
                <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <span
                    className="badge badge-sm"
                    style={{
                      textTransform: 'uppercase',
                      fontSize: 10,
                      fontWeight: 700,
                      background: kindBg,
                      color: '#fff',
                    }}
                  >
                    {kind}
                  </span>
                  <code style={{ fontSize: 12, color: 'var(--text-main)', fontWeight: 600 }}>
                    {d.key}
                  </code>
                  {overwrites && (
                    <span className="badge badge-danger badge-sm" style={{ fontSize: 9, textTransform: 'uppercase' }}>
                      Overwrites existing key
                    </span>
                  )}
                  {d.value === '' && (
                    <span className="badge badge-warning badge-sm" style={{ fontSize: 9, textTransform: 'uppercase' }} title="This entry will set the key to an empty string">
                      Empty value
                    </span>
                  )}
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 12, overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: 300, display: 'inline-flex' }}>
                    =&nbsp;<MaskedValue value={d.value} maxLen={40} />
                  </span>
                  <div style={{ flex: 1 }} />
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => handleRemoveDraft(d.key)} title="Remove" style={{ flexShrink: 0 }}>
                    <Icons.X size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Deployment changes — which infra-deployment manifests the PR will edit */}
          <div style={{ marginTop: 18, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {/* header bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <Icons.GitPullRequestArrow size={15} style={{ color: 'var(--primary)' }} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>Deployment changes</span>
              {previewTargets.some((t) => formatTargetPath(t.path).simulated) && (
                <span className="badge badge-sm" style={{ fontSize: 9, fontWeight: 700, background: '#6b7280', color: '#fff', letterSpacing: '.03em' }}>SIMULATED</span>
              )}
              {!infraLoading && unmatchedTargets.length > 0 && (
                <span
                  className="badge badge-sm"
                  title="These files reference the secret but Hermes couldn't recognize their structure — the key was not registered there"
                  style={{ fontSize: 9, fontWeight: 700, background: '#dc2626', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Icons.AlertTriangle size={10} /> {unmatchedTargets.length} need{unmatchedTargets.length === 1 ? 's' : ''} manual registration
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {infraLoading ? (
                  <><Icons.Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> resolving…</>
                ) : selectedInfraTargets.length > 0 ? (
                  <><Icons.GitPullRequest size={12} /> opens 1 PR · {selectedInfraTargets.length} file{selectedInfraTargets.length > 1 ? 's' : ''}</>
                ) : upToDateTargets.length > 0 ? (
                  <><Icons.Check size={12} /> no new keys · no PR needed</>
                ) : unmatchedTargets.length === 0 ? (
                  <><Icons.Check size={12} /> no PR needed</>
                ) : null}
              </span>
            </div>

            <div style={{ padding: '12px 14px' }}>
              <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                A <strong>new</strong> key name must be registered in the deployment manifests so it syncs to the pods — that's what the PR does. An existing key just takes its value update in AWS, so it needs no manifest change. Untick any file you don't want in the PR, or click a key chip to drop just that key from one file.
              </p>

              {infraLoading ? null : previewTargets.length === 0 && manualTargets.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 11px', border: '1px dashed var(--border)', borderRadius: 6 }}>
                  <Icons.Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>No manifest in <code>infra-deployment</code> references this secret — keys will be written to AWS only. If a service should consume it, add its file below.</span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {newTargets.map((t) => {
                    const included = !excludedTargetPaths.has(t.path);
                    const { display, simulated } = formatTargetPath(t.path);
                    const excludedKeys = excludedKeysByPath[t.path] || EMPTY_KEY_SET;
                    const effectiveCount = t.keysToAdd.filter((k) => !excludedKeys.has(k)).length;
                    return (
                      <div
                        key={t.path}
                        style={{
                          display: 'flex', flexDirection: 'column', gap: 6, padding: '7px 10px', borderRadius: 6,
                          border: '1px solid', borderColor: included ? 'var(--border)' : 'transparent',
                          background: included ? 'var(--bg-card)' : 'transparent',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => toggleTarget(t.path)}>
                          <input
                            type="checkbox"
                            checked={included}
                            onChange={() => toggleTarget(t.path)}
                            onClick={(e) => e.stopPropagation()}
                            style={{ flexShrink: 0 }}
                          />
                          <span className="badge badge-sm" style={{ textTransform: 'uppercase', fontSize: 9, fontWeight: 700, background: envBg(t.env), color: '#fff', flexShrink: 0 }}>{t.env}</span>
                          <span className="badge badge-sm" style={{ fontSize: 9, flexShrink: 0 }}>{t.format === 'spc' ? 'SPC' : 'values'}</span>
                          <code style={{ fontSize: 11.5, textDecoration: included ? 'none' : 'line-through', color: included ? 'var(--text-main)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</code>
                          {simulated && <span className="badge badge-sm" style={{ fontSize: 8, background: '#6b7280', color: '#fff', flexShrink: 0 }}>SIM</span>}
                          <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
                            {included ? (
                              <span className="badge badge-sm" title={`Adds: ${t.keysToAdd.filter((k) => !excludedKeys.has(k)).join(', ') || 'none'}`} style={{ fontSize: 9, fontWeight: 700, background: effectiveCount > 0 ? '#16a34a' : '#6b7280', color: '#fff' }}>
                                +{effectiveCount} new key{effectiveCount !== 1 ? 's' : ''}
                              </span>
                            ) : (
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>skipped</span>
                            )}
                          </span>
                        </div>
                        {included && t.keysToAdd.length > 1 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingLeft: 24 }}>
                            {t.keysToAdd.map((k) => {
                              const keyExcluded = excludedKeys.has(k);
                              return (
                                <button
                                  type="button"
                                  key={k}
                                  onClick={(e) => { e.stopPropagation(); toggleKeyForPath(t.path, k); }}
                                  title={keyExcluded ? 'Excluded from this file — click to include it here' : 'Included in this file — click to exclude it from just this file'}
                                  style={{
                                    fontFamily: 'monospace', fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
                                    background: keyExcluded ? 'transparent' : 'rgba(22, 163, 74, 0.08)',
                                    border: '1px solid ' + (keyExcluded ? 'var(--border)' : 'rgba(22, 163, 74, 0.35)'),
                                    color: keyExcluded ? 'var(--text-muted)' : 'var(--text-main)',
                                    textDecoration: keyExcluded ? 'line-through' : 'none',
                                    opacity: keyExcluded ? 0.6 : 1,
                                    borderRadius: 4, padding: '1px 6px',
                                  }}
                                >
                                  {k}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {manualTargets.map((m) => {
                    const { display } = formatTargetPath(m.path);
                    const excludedKeys = excludedKeysByPath[m.path] || EMPTY_KEY_SET;
                    const effectiveCount = allCandidateKeys.filter((k) => !excludedKeys.has(k)).length;
                    return (
                      <div key={m.path} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Icons.FilePlus2 size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                          <span className="badge badge-sm" style={{ fontSize: 9, flexShrink: 0 }}>added by you</span>
                          <code style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</code>
                          <span className="badge badge-sm" style={{ fontSize: 9, fontWeight: 700, background: effectiveCount > 0 ? '#16a34a' : '#6b7280', color: '#fff', flexShrink: 0 }}>
                            +{effectiveCount} key{effectiveCount !== 1 ? 's' : ''}
                          </span>
                          <button type="button" className="btn btn-outline btn-sm" style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={() => setManualTargets((prev) => prev.filter((x) => x.path !== m.path))} title="Remove file">
                            <Icons.X size={12} />
                          </button>
                        </div>
                        {allCandidateKeys.length > 1 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingLeft: 24 }}>
                            {allCandidateKeys.map((k) => {
                              const keyExcluded = excludedKeys.has(k);
                              return (
                                <button
                                  type="button"
                                  key={k}
                                  onClick={() => toggleKeyForPath(m.path, k)}
                                  title={keyExcluded ? 'Excluded from this file — click to include it here' : 'Included in this file — click to exclude it from just this file'}
                                  style={{
                                    fontFamily: 'monospace', fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
                                    background: keyExcluded ? 'transparent' : 'rgba(22, 163, 74, 0.08)',
                                    border: '1px solid ' + (keyExcluded ? 'var(--border)' : 'rgba(22, 163, 74, 0.35)'),
                                    color: keyExcluded ? 'var(--text-muted)' : 'var(--text-main)',
                                    textDecoration: keyExcluded ? 'line-through' : 'none',
                                    opacity: keyExcluded ? 0.6 : 1,
                                    borderRadius: 4, padding: '1px 6px',
                                  }}
                                >
                                  {k}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* References the secret but the scan couldn't recognize its structure — the
                      key was NOT registered here, unlike the "up to date" files below. */}
                  {unmatchedTargets.map((t) => {
                    const { display } = formatTargetPath(t.path);
                    return (
                      <div
                        key={t.path}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 10px',
                          borderRadius: 6, border: '1px dashed #dc2626', background: 'rgba(220, 38, 38, 0.05)',
                        }}
                      >
                        <Icons.AlertTriangle size={14} style={{ color: '#dc2626', flexShrink: 0, marginTop: 2 }} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span className="badge badge-sm" style={{ textTransform: 'uppercase', fontSize: 9, fontWeight: 700, background: envBg(t.env), color: '#fff', flexShrink: 0 }}>{t.env}</span>
                            <span className="badge badge-sm" style={{ fontSize: 9, flexShrink: 0 }}>{t.format === 'spc' ? 'SPC' : 'values'}</span>
                            <code style={{ fontSize: 11.5, color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</code>
                          </div>
                          <span style={{ fontSize: 11, color: '#dc2626' }}>
                            References this secret, but Hermes couldn't recognize its structure — the key will NOT be registered here automatically. Register it manually in this file.
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  {/* Files that already list every requested key — shown for reassurance, not part of the PR. */}
                  {upToDateTargets.map((t) => {
                    const { display } = formatTargetPath(t.path);
                    return (
                      <div key={t.path} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
                        <Icons.Check size={14} style={{ color: '#16a34a', flexShrink: 0 }} />
                        <span className="badge badge-sm" style={{ textTransform: 'uppercase', fontSize: 9, fontWeight: 700, background: envBg(t.env), color: '#fff', opacity: 0.65, flexShrink: 0 }}>{t.env}</span>
                        <span className="badge badge-sm" style={{ fontSize: 9, flexShrink: 0 }}>{t.format === 'spc' ? 'SPC' : 'values'}</span>
                        <code style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</code>
                        <span style={{ marginLeft: 'auto', fontSize: 10, flexShrink: 0, fontStyle: 'italic' }}>already lists these keys · no change</span>
                      </div>
                    );
                  })}

                  {newTargets.length === 0 && manualTargets.length === 0 && unmatchedTargets.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 2px' }}>
                      <Icons.Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>Every key here already exists in the manifest{upToDateTargets.length > 1 ? 's' : ''} — nothing to change there. Values update in AWS on approval; <strong>no PR needed</strong>.</span>
                    </div>
                  )}
                </div>
              )}

              {/* add-a-file — secondary action, collapsed by default */}
              {showAddFile ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <input
                    className="form-input"
                    placeholder="path/to/values-prod.yaml the scan missed"
                    value={manualPath}
                    onChange={(e) => setManualPath(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManualTarget(); } }}
                    autoFocus
                    style={{ flex: 1, height: 32, fontSize: 12, fontFamily: 'monospace', maxWidth: 460 }}
                  />
                  <button type="button" className="btn btn-outline btn-sm" onClick={addManualTarget} disabled={!manualPath.trim()}>Add</button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => { setShowAddFile(false); setManualPath(''); }}>Cancel</button>
                </div>
              ) : (
                <button type="button" onClick={() => setShowAddFile(true)} style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0 }}>
                  <Icons.Plus size={13} /> Add a file the scan missed
                </button>
              )}
            </div>
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
                  <th style={{ width: 160 }}>Deployment PR</th>
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
                              <span style={{ color: 'var(--text-light)', display: 'inline-flex' }}>
                                {entry.value === null || entry.value === undefined ? (
                                  <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>(Redacted value)</span>
                                ) : (
                                  <>=&nbsp;<MaskedValue value={entry.value} maxLen={20} /></>
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
                    <td style={{ fontSize: 12 }}>
                      <InfraPrCell request={r} />
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
