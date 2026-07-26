import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import * as Icons from 'lucide-react';
import LoadingSpinner from '../components/common/LoadingSpinner';
import SectionHeader from '../components/common/SectionHeader';
import CopyButton from '../components/common/CopyButton';
import { SearchableSelect } from '../components/common/SearchableSelect';
import { useToast } from '../contexts/ToastContext';
import { queryKeys } from '../lib/queryKeys';
import { envBg, envOf, formatTargetPath, INFRA_STATE_META } from '../lib/infraTargetFormat';
import {
  getSecretScope,
  listSecretKeys,
  listIngestionRequests,
  submitIngestionRequestsBulk,
  withdrawIngestionRequest,
  previewInfraTargets,
  listSecretsInstances,
  deriveEnvVar,
  type SecretIngestionRequest,
  type InfraTargetSelection,
} from '../services/api/secretsApi';
import ReasonModal from '../components/common/ReasonModal';
import { precheckSecretKey } from '../lib/secretKeyPrecheck';

/** Stable empty-set reference for the "no keys excluded for this path yet" default. */
const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

/** Micro-steps the gimmick "AI" precheck cycles through while it "scans" a key name.
 *  Module-level so the effect that plays them has a stable reference. */
const AI_SCAN_STEPS = [
  'Analyzing key semantics…',
  'Matching against secret taxonomy…',
  'Scoring configuration likelihood…',
];

/** Sarcastic one-liners shown on the FAIL verdict — one per distinct blocked key the user
 *  types (not a timed rotation), so retyping a new offending key surfaces a fresh line.
 *  Module-level so the picking effect has a stable reference. */
const AI_SARCASM_LINES = [
  'AI ne bol diya — ye secret nahi, sirf drama hai.',
  'Itni mehnat se galat jagah daal rahe ho, respect hai.',
  'Ten out of ten for creativity, zero out of ten for secrecy.',
  'Even the AI is embarrassed for you right now. This one is config not secret.',
  'This key belongs in a YAML file, not a vault.',
  'Rejected — with love, but mostly with judgment.',
  'This seems to be config, not secret. Common sense has taken a big toll today.',
  'Aap chronology samajhiye: URL config hai, secret nahi.',
  'Moye moye… tera key reject ho gaya.',
  'Sir Jee, this is a Secrets Manager, not a ConfigMap.',
];
/** Stable empty (never-mutated) Set default for a secret with no excluded target paths yet. */
const EMPTY_PATH_SET: Set<string> = new Set();

const STATUS_BADGE: Record<SecretIngestionRequest['status'], string> = {
  PENDING: 'badge-pending',
  APPLYING: 'badge-pending',
  APPLIED: 'badge-active',
  // Terminal-but-mixed — amber with a border, distinct from in-flight PENDING.
  PARTIALLY_APPLIED: 'badge-warning',
  APPLY_FAILED: 'badge-danger',
  REJECTED: 'badge-danger',
  // Neutral — the requester ended this themselves, it was never rejected.
  WITHDRAWN: 'badge-revoked',
};

interface DraftEntry {
  key: string;
  value: string;
  /** Azure only: the env var this key lands in (`secretsStore.mappings[].key`). */
  envVar?: string;
}

/** What a SecretCartGroup reports up to the page: the deployment targets it will submit for its
 *  secret (undefined ⇒ let the backend auto-resolve), plus whether its infra preview is still
 *  in flight (so the page can disable the batch submit until every secret has resolved). */
interface ResolvedTargets {
  infraTargets?: InfraTargetSelection[];
  loading: boolean;
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
      <CopyButton value={value} title="Copy secret value" size={13} />
    </span>
  );
};

/**
 * Gimmick "AI verification" panel for the Add Key-Value form. Rendered ONLY when the
 * typed key name trips the non-secret precheck (url / uri / autoStartup / …): it plays
 * a brief scan animation, then shows a hard FAIL verdict explaining the key is config,
 * not a secret, plus a sarcastic one-liner that advances one step per distinct offending
 * key typed (see AI_SARCASM_LINES). A clean (secret-shaped) key renders nothing — the
 * check is invisible unless there's something to block, exactly as requested.
 *
 * `sarcasmIndex` is computed by the parent, not this component: this component mounts and
 * unmounts every time `blocked` flips (which happens mid-keystroke — e.g. typing "test"
 * letter by letter passes through non-blocked prefixes before re-tripping the check), so
 * any counter kept in local state/ref here would reset to 0 on every remount and the same
 * first line would show forever. The parent stays mounted for the whole page session, so
 * that's where the running count has to live.
 */
const AiKeyPrecheck: React.FC<{ matched: string; keyName: string; sarcasmIndex: number }> = ({
  matched,
  keyName,
  sarcasmIndex,
}) => {
  const [phase, setPhase] = useState<'scanning' | 'failed'>('scanning');
  const [step, setStep] = useState(0);

  // Replay the scan each time the offending key text changes (e.g. edited url → uri).
  React.useEffect(() => {
    setPhase('scanning');
    setStep(0);
    const stepTimers = AI_SCAN_STEPS.map((_, i) => setTimeout(() => setStep(i), i * 280));
    const done = setTimeout(() => setPhase('failed'), 950);
    return () => {
      stepTimers.forEach(clearTimeout);
      clearTimeout(done);
    };
  }, [keyName]);

  if (phase === 'scanning') {
    return (
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 6,
          border: '1px solid rgba(99, 102, 241, 0.35)', background: 'rgba(99, 102, 241, 0.07)',
        }}
      >
        <Icons.Sparkles size={15} style={{ color: '#6366f1', flexShrink: 0 }} />
        <Icons.Loader size={13} style={{ color: '#6366f1', flexShrink: 0, animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 12, color: 'var(--text-main)', fontWeight: 500 }}>
          AI verifying key name — {AI_SCAN_STEPS[step]}
        </span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 6,
        border: '1px solid #dc2626', background: 'rgba(220, 38, 38, 0.06)',
      }}
    >
      <Icons.Ban size={15} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#dc2626', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icons.Sparkles size={12} /> AI verification failed
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-main)', lineHeight: 1.45 }}>
          <code style={{ fontSize: 11.5 }}>{keyName}</code> contains <code style={{ fontSize: 11.5 }}>{matched}</code> — this looks like
          <strong> configuration, not a secret</strong>, so it can't be ingested here. Put endpoint URLs,
          connection URIs and <code style={{ fontSize: 11.5 }}>autoStartup</code> flags in Properties Config / a ConfigMap instead.
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {AI_SARCASM_LINES[sarcasmIndex]}
        </span>
      </div>
    </div>
  );
};

/** Copies a key name to the clipboard AND fills it into the "Add Key-Value Entry" form
 *  (via onUse) in one click — used in the Existing Keys list so updating an existing
 *  key's value doesn't require retyping its name. */
const CopyAndUseKeyButton: React.FC<{ value: string; onUse: (value: string) => void }> = ({ value, onUse }) => {
  const [copied, setCopied] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    onUse(value);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={copied ? 'Copied & filled in!' : 'Copy & use this key'}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: copied ? '#16a34a' : 'var(--text-muted)',
        padding: '2px 4px',
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        flexShrink: 0,
        transition: 'all 0.15s ease',
      }}
    >
      {copied ? <Icons.Check size={12} /> : <Icons.Copy size={12} />}
    </button>
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

interface SecretCartGroupProps {
  secretName: string;
  platform: string;
  /** Azure (Key Vault) instance: entries carry an env-var name, and no target file is preselected. */
  isAzure: boolean;
  entries: DraftEntry[];
  onRemoveEntry: (key: string) => void;
  onDiscard: () => void;
  // This secret's slice of the page's per-secret deployment-target selection state.
  excludedTargetPaths: Set<string>;
  onToggleTarget: (path: string) => void;
  excludedKeysByPath: Record<string, Set<string>>;
  onToggleKeyForPath: (path: string, key: string) => void;
  manualTargets: { path: string }[];
  onAddManualTarget: (path: string) => void;
  onRemoveManualTarget: (path: string) => void;
  // Reports the resolved deployment targets + preview-loading state up to the page.
  onResolved: (value: ResolvedTargets) => void;
}

/**
 * One secret's basket inside the multi-secret cart: its staged key-value entries plus the
 * deployment-PR file/key picker, driven by that secret's slice of the page's per-secret state.
 * Owns its own "existing keys" and "infra preview" queries (React Query dedupes them against the
 * page's own queries by key), and reports the deployment targets it will submit back up via
 * `onResolved` so the page can build the bulk payload and gate the batch submit on preview loading.
 */
const SecretCartGroup: React.FC<SecretCartGroupProps> = ({
  secretName,
  platform,
  isAzure,
  entries,
  onRemoveEntry,
  onDiscard,
  excludedTargetPaths,
  onToggleTarget,
  excludedKeysByPath,
  onToggleKeyForPath,
  manualTargets,
  onAddManualTarget,
  onRemoveManualTarget,
  onResolved,
}) => {
  const toast = useToast();
  const [manualPath, setManualPath] = useState('');
  const [showAddFile, setShowAddFile] = useState(false);

  const draftKeys = useMemo(() => entries.map((d) => d.key), [entries]);

  // Existing AWS keys for this secret — powers the ADD vs UPDATE badge. Same query key the page's
  // Existing-Keys panel uses, so it's one shared cache entry (no duplicate request).
  const { data: existingKeysData } = useQuery({
    queryKey: queryKeys.secretKeys(platform, secretName),
    queryFn: () => listSecretKeys(secretName, platform),
    enabled: !!secretName,
  });

  const { data: infraPreview, isFetching: infraLoading } = useQuery({
    queryKey: queryKeys.secretInfraPreview(platform, secretName, draftKeys),
    queryFn: () => previewInfraTargets(secretName, draftKeys, platform),
    enabled: !!secretName && draftKeys.length > 0,
  });

  const previewTargets = useMemo(() => infraPreview?.targets ?? [], [infraPreview]);
  // A file only needs the PR when it's MISSING one of the keys (a new key name). A file that
  // already lists every key just takes the value update in AWS — no manifest change.
  const newTargets = useMemo(() => previewTargets.filter((t) => t.keysToAdd.length > 0), [previewTargets]);
  // Referenced the secret but the scan couldn't recognize its structure — the key was NOT
  // registered here. Must never be shown as "up to date".
  const unmatchedTargets = useMemo(() => previewTargets.filter((t) => t.unmatched), [previewTargets]);
  const upToDateTargets = useMemo(
    () => previewTargets.filter((t) => t.keysToAdd.length === 0 && !t.unmatched),
    [previewTargets],
  );

  // The candidate key list offered for a manually-added file — no live diff for an arbitrary
  // path, so offer every key the scan found missing anywhere, falling back to every drafted key.
  const allCandidateKeys = useMemo(() => {
    const fromScan = [...new Set(newTargets.flatMap((t) => t.keysToAdd))];
    return fromScan.length > 0 ? fromScan : draftKeys;
  }, [newTargets, draftKeys]);

  // Azure: ONE vault (bachatt-prod-kv) backs several services, so the auto-scan finds every
  // manifest that consumes it — orbit, saathi-be and tolgee all match — not just the service this
  // key belongs to. Leaving them ticked by default would append the key to all of them, mounting a
  // secret into unrelated workloads. Start every discovered file UNticked so the requester has to
  // consciously pick the one service. (AWS is unaffected: there a secret's consumers ARE the
  // services that should get the key, so ticked-by-default is correct.)
  const autoExcludedRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!isAzure) return;
    for (const t of newTargets) {
      if (autoExcludedRef.current.has(t.path)) continue;
      autoExcludedRef.current.add(t.path);
      if (!excludedTargetPaths.has(t.path)) onToggleTarget(t.path);
    }
    // excludedTargetPaths/onToggleTarget deliberately omitted — this must run once per newly
    // DISCOVERED path, not on every user tick (which would immediately undo their choice).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAzure, newTargets]);

  // The final file selection this secret will submit: auto-detected files kept, plus any added
  // by hand (de-duped by path). Empty ⇒ let the backend auto-resolve at PR time.
  const selectedInfraTargets: InfraTargetSelection[] = useMemo(() => {
    const byPath = new Map<string, InfraTargetSelection>();
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
      byPath.set(m.path, { path: m.path, keys, env: envOf(m.path) });
    }
    return [...byPath.values()];
  }, [newTargets, excludedTargetPaths, excludedKeysByPath, manualTargets, allCandidateKeys]);

  // What the page should send for this secret. An explicit [] means "no files → no PR" and is
  // honored — EXCEPT when it's empty only because every consumer was unmatched: sending []
  // would produce a false "no manifest changes" note, so send undefined to let the backend
  // auto-resolve and report the real "register manually" note.
  const finalTargets =
    infraPreview
      ? selectedInfraTargets.length === 0 && unmatchedTargets.length > 0
        ? undefined
        : selectedInfraTargets
      : undefined;

  // Report the resolved targets + loading state up. Keyed on a stable signature so this fires
  // only on a real change; the page's setter also guards equality, so no update loop.
  const resolvedSig = JSON.stringify(finalTargets ?? null);
  const onResolvedRef = React.useRef(onResolved);
  onResolvedRef.current = onResolved;
  React.useEffect(() => {
    onResolvedRef.current({ infraTargets: finalTargets, loading: infraLoading });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedSig, infraLoading]);

  const addManual = () => {
    const p = manualPath.trim();
    if (!p) return;
    if (previewTargets.some((t) => t.path === p) || manualTargets.some((m) => m.path === p)) {
      toast.error('That file is already in the list.');
      return;
    }
    onAddManualTarget(p);
    setManualPath('');
  };

  return (
    <div className="bulk-request-panel" style={{ marginTop: 20 }}>
      <div className="bulk-request-header">
        <div className="bulk-request-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icons.ListChecks size={18} style={{ color: 'var(--primary)' }} />
          <code title={secretName} style={{ wordBreak: 'break-all' }}>{secretName}</code>
          <CopyButton value={secretName} title="Copy secret name" size={13} />
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={onDiscard}>
          Remove secret
        </button>
      </div>

      <div style={{ padding: '0 4px' }}>
        {entries.map((d) => {
          const overwrites = existingKeysData?.keys.includes(d.key) || false;
          const kind = overwrites ? 'UPDATE' : 'ADD';
          const kindBg = overwrites ? '#d97706' : '#16a34a';
          return (
            <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span
                className="badge badge-sm"
                style={{ textTransform: 'uppercase', fontSize: 10, fontWeight: 700, background: kindBg, color: '#fff' }}
              >
                {kind}
              </span>
              <code style={{ fontSize: 12, color: 'var(--text-main)', fontWeight: 600 }}>{d.key}</code>
              <CopyButton value={d.key} title="Copy key name" size={12} />
              {isAzure && (
                <span
                  className="badge badge-sm"
                  title={`Exposed to the pod as the environment variable ${d.envVar || deriveEnvVar(d.key)}`}
                  style={{ fontSize: 9, fontFamily: 'monospace', fontWeight: 700 }}
                >
                  → {d.envVar || deriveEnvVar(d.key)}
                </span>
              )}
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
              <button type="button" className="btn btn-outline btn-sm" onClick={() => onRemoveEntry(d.key)} title="Remove" style={{ flexShrink: 0 }}>
                <Icons.X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Deployment changes — which infra-deployment manifests the PR will edit */}
      <div style={{ marginTop: 18, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
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
            {isAzure ? (
              <>
                <strong>New</strong> key names need a manifest entry to reach the pods (the PR); existing keys just update in Key Vault.
                One vault backs every Azure service, so <strong>tick only the service that needs this key</strong>.
              </>
            ) : (
              <>
                <strong>New</strong> key names need a manifest entry to reach the pods (the PR); existing keys just update in AWS. Untick a file, or a key chip, to exclude it.
              </>
            )}
          </p>

          {/* Azure starts every file unticked (see autoExcludedRef) — so an untouched picker means
              the key lands in Key Vault but no pod ever sees it. Warn, but never block: an
              update-only request legitimately selects no file. */}
          {isAzure && !infraLoading && newTargets.length > 0 && selectedInfraTargets.length === 0 && (
            <div style={{ fontSize: 12, color: '#b45309', display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 11px', border: '1px solid #f59e0b', background: 'rgba(245, 158, 11, 0.08)', borderRadius: 6, marginBottom: 10 }}>
              <Icons.AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                No target file selected — the value will be written to Key Vault, but <strong>no pod will see it</strong>.
                Tick the service that needs it, unless you are only updating an existing key's value.
              </span>
            </div>
          )}

          {infraLoading ? null : previewTargets.length === 0 && manualTargets.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 11px', border: '1px dashed var(--border)', borderRadius: 6 }}>
              <Icons.Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>No manifest in <code>infra-deployment</code> references this {isAzure ? 'vault' : 'secret'} — keys will be written to {isAzure ? 'Key Vault' : 'AWS'} only. If a service should consume it, add its file below.</span>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => onToggleTarget(t.path)}>
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => onToggleTarget(t.path)}
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
                              onClick={(e) => { e.stopPropagation(); onToggleKeyForPath(t.path, k); }}
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
                      <button type="button" className="btn btn-outline btn-sm" style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={() => onRemoveManualTarget(m.path)} title="Remove file">
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
                              onClick={() => onToggleKeyForPath(m.path, k)}
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
                  <span>Every key here already exists in the manifest{upToDateTargets.length > 1 ? 's' : ''} — nothing to change there. Values update in {isAzure ? 'Key Vault' : 'AWS'} on approval; <strong>no PR needed</strong>.</span>
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
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
                autoFocus
                style={{ flex: 1, height: 32, fontSize: 12, fontFamily: 'monospace', maxWidth: 460 }}
              />
              <button type="button" className="btn btn-outline btn-sm" onClick={addManual} disabled={!manualPath.trim()}>Add</button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => { setShowAddFile(false); setManualPath(''); }}>Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => setShowAddFile(true)} style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0 }}>
              <Icons.Plus size={13} /> Add a file the scan missed
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const SecretIngestion: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [searchParams, setSearchParams] = useSearchParams();
  const urlPlatform = searchParams.get('platform');
  const urlSecret = searchParams.get('secret');

  // The selected Secret Ingestion instance (AWS account) — prod ("secrets") by default; the
  // chooser below switches to "secrets-sandbox" when configured. Every query/mutation is scoped
  // to it, so the whole page reflects one account at a time.
  const [selectedPlatform, setSelectedPlatform] = useState<string>(() => urlPlatform || 'secrets');

  const [selectedSecret, setSelectedSecret] = useState<string>(() => urlSecret || '');

  // The request the withdraw confirmation is open for (null = closed).
  const [withdrawing, setWithdrawing] = useState<SecretIngestionRequest | null>(null);

  // Sync state from URL params
  React.useEffect(() => {
    if (urlPlatform && urlPlatform !== selectedPlatform) {
      setSelectedPlatform(urlPlatform);
    }
  }, [urlPlatform, selectedPlatform]);

  React.useEffect(() => {
    if (urlSecret !== null && urlSecret !== selectedSecret) {
      setSelectedSecret(urlSecret);
    }
  }, [urlSecret, selectedSecret]);

  const handleSecretChange = (secretName: string) => {
    setSelectedSecret(secretName);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (secretName) {
        next.set('secret', secretName);
      } else {
        next.delete('secret');
      }
      return next;
    }, { replace: true });
  };

  const handlePlatformChange = (platformKey: string) => {
    setSelectedPlatform(platformKey);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('platform', platformKey);
      next.delete('secret'); // Switch platform clears selected secret
      return next;
    }, { replace: true });
  };

  // In-memory only — these hold real, unsubmitted secret values, so they are deliberately NOT
  // persisted to localStorage (would sit there in plaintext indefinitely, unscoped by user). The
  // whole cart (values + per-secret deployment selections) is lost on refresh/navigation by design.
  const [drafts, setDrafts] = useState<Record<string, DraftEntry[]>>({});

  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  // Azure only: the env var the new key is exposed as. Blank ⇒ derived from the key name on submit.
  const [newEnvVar, setNewEnvVar] = useState('');
  // One justification for the whole cart checkout (applied to every fanned-out request).
  const [batchJustification, setBatchJustification] = useState('');
  const [keySearch, setKeySearch] = useState('');
  const [secretPrefix, setSecretPrefix] = useState('');
  // Secrets ticked for broadcast: a key-value pair added while any are checked is staged into
  // every checked secret at once (same value). Sticky — stays checked across adds until cleared,
  // so several keys can be broadcast to the same set. Empty ⇒ the add-form targets the single
  // focused `selectedSecret` (today's behavior). Dropped on instance switch.
  const [checkedSecrets, setCheckedSecrets] = useState<Set<string>>(new Set());

  // Per-secret deployment-target selection (keyed by secret name, same as `drafts`): files the
  // requester un-ticks, extra files added by path, and per-file key narrowing — all scoped to a
  // secret so the cart can hold independent selections for each.
  const [excludedTargetsBySecret, setExcludedTargetsBySecret] = useState<Record<string, Set<string>>>({});
  const [manualTargetsBySecret, setManualTargetsBySecret] = useState<Record<string, { path: string }[]>>({});
  const [excludedKeysBySecret, setExcludedKeysBySecret] = useState<Record<string, Record<string, Set<string>>>>({});
  // Reported up by each SecretCartGroup: the deployment targets it will submit + its preview
  // loading state. Read at submit to build the payload and to gate the batch button.
  const [resolvedBySecret, setResolvedBySecret] = useState<Record<string, ResolvedTargets>>({});

  // ── Queries ───────────────────────────────────────────────────────────────────
  // The configured instances (prod + any sandbox). The chooser only renders when >1.
  const { data: instances = [] } = useQuery({
    queryKey: queryKeys.secretsInstances(),
    queryFn: listSecretsInstances,
  });

  // Azure (Key Vault) instance? Drives the env-var field, the default-unticked target picker, and
  // the vault-vs-secret wording. Read off the instance's `provider` rather than matching the key
  // string, so a second Azure instance needs no frontend change.
  const isAzureInstance = React.useMemo(
    () => instances.find((i) => i.key === selectedPlatform)?.provider === 'azure',
    [instances, selectedPlatform],
  );

  // Provider-aware copy. On Azure the backing store is a Key Vault, not AWS Secrets Manager, and
  // the "secret" IS the vault — so AWS wording isn't merely imprecise, it describes the wrong
  // thing (Hermes can create a secret inside a vault, never a vault).
  const copy = React.useMemo(
    () =>
      isAzureInstance
        ? {
            storeName: 'Azure Key Vault',
            targetLabel: 'Target Key Vault',
            emptyScope: "You don't have access to any Key Vault yet.",
            missingTarget:
              'This is not a Key Vault this instance can write to — pick the vault from the list above.',
          }
        : {
            storeName: 'AWS Secrets Manager',
            targetLabel: 'Target AWS Secret',
            emptyScope: "You don't have access to any AWS secrets yet.",
            missingTarget: 'Secret does not exist in AWS yet. Ingestion will create it.',
          },
    [isAzureInstance],
  );

  // Keep the selection valid once instances load (e.g. sandbox-only deployments have no "secrets").
  React.useEffect(() => {
    if (instances.length === 0) return;
    if (!instances.some((i) => i.key === selectedPlatform)) {
      setSelectedPlatform(instances[0].key);
    }
  }, [instances, selectedPlatform]);

  // Switching instance = a different AWS account: drop the selected secret, prefix filter, and the
  // entire cart (values + per-secret selections belong to the previous account and must not carry over).
  React.useEffect(() => {
    const urlPlatformParam = searchParams.get('platform');
    const urlSecretParam = searchParams.get('secret');
    if (selectedPlatform !== urlPlatformParam || !urlSecretParam) {
      setSelectedSecret('');
    }
    setSecretPrefix('');
    setDrafts({});
    setExcludedTargetsBySecret({});
    setManualTargetsBySecret({});
    setExcludedKeysBySecret({});
    setResolvedBySecret({});
    setBatchJustification('');
    setCheckedSecrets(new Set());
  }, [selectedPlatform]);

  const { data: scope = [], isLoading: scopeLoading } = useQuery({
    queryKey: queryKeys.secretsScope(selectedPlatform),
    queryFn: () => getSecretScope(selectedPlatform),
  });

  const {
    data: existingKeysData,
    isLoading: keysLoading,
    isError: keysErrored,
    error: keysError,
  } = useQuery({
    queryKey: queryKeys.secretKeys(selectedPlatform, selectedSecret),
    queryFn: () => listSecretKeys(selectedSecret, selectedPlatform),
    enabled: !!selectedSecret,
    // A permission/connectivity failure (e.g. Azure denying data-plane access to one vault while
    // ARM discovery still lists it) must never be silently retried into looking like "doesn't
    // exist" — surface it once, distinctly, rather than looping on a request that can't succeed.
    retry: false,
  });

  const { data: myRequests = [] } = useQuery({
    queryKey: queryKeys.secretIngestionRequests('mine', selectedPlatform),
    queryFn: () => listIngestionRequests('mine', selectedPlatform),
    // The infra-deployment PR opens asynchronously after submit — poll briefly so its
    // link/state surfaces here without a manual refresh.
    refetchInterval: 12000,
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

  // Stage 1 (pre-filter): keep only secrets whose name STARTS WITH the prefix.
  const prefixFilteredOptions = useMemo(() => {
    const p = secretPrefix.trim().toLowerCase();
    if (!p) return secretOptions;
    return secretOptions.filter((o) => o.secretName.toLowerCase().startsWith(p));
  }, [secretOptions, secretPrefix]);

  // Keep the selection inside the (possibly prefix-filtered) option set.
  React.useEffect(() => {
    if (scopeLoading) return;
    if (prefixFilteredOptions.some((o) => o.secretName === selectedSecret)) return;
    if (secretOptions.some((o) => o.secretName === selectedSecret)) return;
    setSelectedSecret(prefixFilteredOptions[0]?.secretName ?? '');
  }, [prefixFilteredOptions, selectedSecret, scopeLoading, secretOptions]);

  // Reset key search when user switches secrets
  React.useEffect(() => {
    setKeySearch('');
  }, [selectedSecret]);

  // Secrets with a non-empty basket — the cart. Sorted for a stable render order.
  const cartSecrets = useMemo(
    () => Object.keys(drafts).filter((s) => (drafts[s]?.length ?? 0) > 0).sort((a, b) => a.localeCompare(b)),
    [drafts],
  );
  const totalCartKeys = useMemo(
    () => cartSecrets.reduce((n, s) => n + (drafts[s]?.length ?? 0), 0),
    [cartSecrets, drafts],
  );

  // A secret is still "resolving" until its group reports back (undefined) or reports loading.
  const anyResolving = useMemo(
    () => cartSecrets.some((s) => !resolvedBySecret[s] || resolvedBySecret[s].loading),
    [cartSecrets, resolvedBySecret],
  );

  // ── Per-secret selection updaters (passed down to each SecretCartGroup) ─────────
  const handleResolved = React.useCallback((secret: string, value: ResolvedTargets) => {
    setResolvedBySecret((prev) => {
      const cur = prev[secret];
      if (
        cur &&
        cur.loading === value.loading &&
        JSON.stringify(cur.infraTargets ?? null) === JSON.stringify(value.infraTargets ?? null)
      ) {
        return prev; // unchanged — avoid a needless re-render / update loop
      }
      return { ...prev, [secret]: value };
    });
  }, []);

  const toggleTarget = (secret: string, path: string) =>
    setExcludedTargetsBySecret((prev) => {
      const next = new Set(prev[secret] || []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...prev, [secret]: next };
    });

  const toggleKeyForPath = (secret: string, path: string, key: string) =>
    setExcludedKeysBySecret((prev) => {
      const forSecret = { ...(prev[secret] || {}) };
      const set = new Set(forSecret[path] || []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      forSecret[path] = set;
      return { ...prev, [secret]: forSecret };
    });

  const addManualTarget = (secret: string, path: string) =>
    setManualTargetsBySecret((prev) => ({
      ...prev,
      [secret]: [...(prev[secret] || []), { path }],
    }));

  const removeManualTarget = (secret: string, path: string) =>
    setManualTargetsBySecret((prev) => ({
      ...prev,
      [secret]: (prev[secret] || []).filter((m) => m.path !== path),
    }));

  const toggleChecked = (name: string) =>
    setCheckedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Non-secret precheck for the currently typed key — drives the gimmick AI panel and
  // gates the add button/form so a config-shaped key (url/uri/autoStartup/…) never enters the cart.
  // Keys already in the focused secret are exempt: they're value updates, not new config being
  // introduced, and blocking them would strand every legacy `*_url`/`*_uri` key (the Existing Keys
  // list's copy-and-use button fills exactly those names into this form).
  const keyPrecheck = useMemo(
    () => precheckSecretKey(newKey, existingKeysData?.keys),
    [newKey, existingKeysData?.keys],
  );

  // Which AI_SARCASM_LINES entry the fail panel shows — tracked here, not inside
  // AiKeyPrecheck, because that component mounts/unmounts every time `blocked` flips (which
  // happens mid-keystroke), so a counter kept there resets to 0 on every remount and the
  // first line would show forever. This page component stays mounted for the whole session,
  // so the running count survives.
  //
  // Advances exactly once per appearance of the panel — i.e. on each false → true edge of
  // `blocked`, not per keystroke. Editing an already-blocked key (url → uri, or typing more
  // characters onto a key that already trips the check) keeps the same line; the next line
  // comes when the key goes clean and trips the check again.
  const [sarcasmIndex, setSarcasmIndex] = useState(0);
  const sarcasmTryRef = React.useRef(0);
  React.useEffect(() => {
    if (!keyPrecheck.blocked) return;
    setSarcasmIndex(sarcasmTryRef.current % AI_SARCASM_LINES.length);
    sarcasmTryRef.current += 1;
  }, [keyPrecheck.blocked]);

  const handleAddDraft = (e: React.FormEvent) => {
    e.preventDefault();
    const keyTrimmed = newKey.trim();
    if (!keyTrimmed) {
      toast.error('Key name cannot be empty');
      return;
    }
    // Same rule the AI panel shows: block config-shaped keys before they reach the cart — new
    // ones only; an existing key is an update and always allowed through.
    const precheck = precheckSecretKey(keyTrimmed, existingKeysData?.keys);
    if (precheck.blocked) {
      toast.error(`AI precheck blocked "${keyTrimmed}": contains "${precheck.matched}" — that's configuration, not a secret.`);
      return;
    }
    // Broadcast to every checked secret when any are ticked; otherwise stage into the single
    // focused secret (today's behavior). The same value is written to each target.
    const targets =
      checkedSecrets.size > 0 ? [...checkedSecrets] : selectedSecret ? [selectedSecret] : [];
    if (targets.length === 0) {
      toast.error('Select a secret first');
      return;
    }

    // A secret that already has this key staged is skipped (its existing value is kept, not
    // overwritten) — computed off the current drafts, not inside the setState updater.
    const toAdd = targets.filter((s) => !(drafts[s] || []).some((d) => d.key === keyTrimmed));
    const skippedCount = targets.length - toAdd.length;

    if (toAdd.length === 0) {
      toast.error(
        targets.length === 1
          ? 'Key already exists in draft list'
          : `"${keyTrimmed}" is already staged in all ${targets.length} selected secrets`,
      );
      return;
    }

    const newEntry: DraftEntry = {
      key: keyTrimmed,
      value: newValue,
      // Blank ⇒ leave undefined so the backend derives it; only a deliberate override is stored.
      ...(isAzureInstance && newEnvVar.trim() ? { envVar: newEnvVar.trim() } : {}),
    };
    setDrafts((prev) => {
      const next = { ...prev };
      for (const s of toAdd) next[s] = [...(prev[s] || []), newEntry];
      return next;
    });

    if (targets.length > 1) {
      toast.success(
        `Added "${keyTrimmed}" to ${toAdd.length} secret${toAdd.length > 1 ? 's' : ''}` +
          (skippedCount ? ` · skipped ${skippedCount} already staged` : ''),
      );
    }
    setNewKey('');
    setNewValue('');
    setNewEnvVar('');
  };

  const handleRemoveDraft = (secret: string, keyToRemove: string) => {
    setDrafts((prev) => ({
      ...prev,
      [secret]: (prev[secret] || []).filter((d) => d.key !== keyToRemove),
    }));
  };

  // Drop one secret from the cart entirely — its entries and all its per-secret selections.
  const handleDiscardSecret = (secret: string) => {
    setDrafts((prev) => {
      const copy = { ...prev };
      delete copy[secret];
      return copy;
    });
    setExcludedTargetsBySecret((prev) => {
      const copy = { ...prev };
      delete copy[secret];
      return copy;
    });
    setManualTargetsBySecret((prev) => {
      const copy = { ...prev };
      delete copy[secret];
      return copy;
    });
    setExcludedKeysBySecret((prev) => {
      const copy = { ...prev };
      delete copy[secret];
      return copy;
    });
    setResolvedBySecret((prev) => {
      const copy = { ...prev };
      delete copy[secret];
      return copy;
    });
  };

  // ── Mutation — multi-secret cart checkout ──────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: () =>
      submitIngestionRequestsBulk({
        platform: selectedPlatform,
        secrets: cartSecrets.map((s) => ({
          secretName: s,
          justification: batchJustification.trim() || undefined,
          // envVar is Azure-only and optional — carried through so a requester override reaches the
          // manifest editor; omitted entirely when unset, leaving AWS payloads byte-identical.
          entries: (drafts[s] || []).map((d) => ({
            key: d.key,
            value: d.value,
            ...(d.envVar ? { envVar: d.envVar } : {}),
          })),
          infraTargets: resolvedBySecret[s]?.infraTargets,
        })),
      }),
    onSuccess: (result) => {
      const ok = result.submitted.length;
      const bad = result.failed.length;
      if (bad === 0) {
        toast.success(
          ok === 1
            ? 'Request submitted. A deployment PR will appear under “My Ingestion Requests”.'
            : `${ok} requests submitted. Deployment PRs will appear under “My Ingestion Requests”.`,
        );
      } else if (ok === 0) {
        toast.error(`All ${bad} secret(s) failed: ${result.failed.map((f) => `${f.secretName} (${f.error})`).join('; ')}`);
      } else {
        toast.error(`${ok} submitted, ${bad} failed: ${result.failed.map((f) => `${f.secretName} (${f.error})`).join('; ')}`);
      }
      // Clear the whole cart on any partial success; secrets that failed are reported in the toast.
      setDrafts({});
      setExcludedTargetsBySecret({});
      setManualTargetsBySecret({});
      setExcludedKeysBySecret({});
      setResolvedBySecret({});
      setBatchJustification('');
      queryClient.invalidateQueries({ queryKey: queryKeys.secretIngestionRequests('mine', selectedPlatform) });
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to submit requests.'),
  });

  const withdrawMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => withdrawIngestionRequest(id, reason || undefined),
    onSuccess: () => {
      toast.success('Request withdrawn. Its deployment PR is being closed.');
      setWithdrawing(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.secretIngestionRequests('mine', selectedPlatform) });
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to withdraw request.'),
  });

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
              onClick={() => handlePlatformChange(inst.key)}
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

  // Small cart summary shown by the header once anything is staged.
  const cartBadge = cartSecrets.length > 0 && (
    <span
      className="badge badge-sm"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--primary)', color: '#fff', fontWeight: 700 }}
      title="Staged across all secrets — submit them together below"
    >
      <Icons.ShoppingCart size={12} />
      Cart · {cartSecrets.length} secret{cartSecrets.length > 1 ? 's' : ''} · {totalCartKeys} key{totalCartKeys > 1 ? 's' : ''}
    </span>
  );

  if (scopeLoading) {
    return (
      <div>
        <SectionHeader
          title="Secret Ingestion"
          icon={<Icons.KeyRound size={18} />}
          meta={`Propose secret key-value pairs to merge into ${copy.storeName}`}
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
        meta={`Propose secret key-value pairs to merge into ${copy.storeName}`}
        actions={cartBadge || undefined}
      />

      {platformChooser}

      {secretOptions.length === 0 ? (
        <div className="empty-state">
          <Icons.Key size={40} className="empty-state-icon" />
          <p className="empty-state-desc">{copy.emptyScope}</p>
        </div>
      ) : (
        <div className="table-container" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Picker on the left; when secrets are checked for broadcast, a chip list of the
                chosen secrets fills the space on the right. */}
            <div style={{ display: 'grid', gridTemplateColumns: checkedSecrets.size > 0 ? '1fr 1fr' : '1fr', gap: 24, alignItems: 'start' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" style={{ fontWeight: 600 }}>{copy.targetLabel}</label>
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
              {/* Stage 2 — the selector's own search does a substring match within the pre-filtered
                  set. Tick the checkboxes to stage the same key-value pair into several secrets at
                  once; leave them unticked to target the single focused secret. */}
              <SearchableSelect
                options={prefixFilteredOptions.map((opt) => ({
                  value: opt.secretName,
                  label: opt.secretName,
                  groupName: opt.groupName,
                }))}
                value={selectedSecret}
                onChange={(val) => handleSecretChange(val)}
                style={{ maxWidth: 400 }}
                selectedValues={checkedSecrets}
                onToggleValue={toggleChecked}
                onSelectAllFiltered={(vals) => setCheckedSecrets((prev) => new Set([...prev, ...vals]))}
                onClearSelection={() => setCheckedSecrets(new Set())}
              />
              {checkedSecrets.size > 0 && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, maxWidth: 400 }}>
                  <Icons.Info size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                  A key-value pair you add will be staged into all {checkedSecrets.size} checked secret{checkedSecrets.size > 1 ? 's' : ''} (same value). Selection stays until you clear it.
                </p>
              )}
            </div>

            {checkedSecrets.size > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <h4 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-main)', margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icons.CheckSquare size={15} style={{ color: 'var(--primary)' }} />
                    Selected for broadcast ({checkedSecrets.size})
                  </h4>
                  <button
                    type="button"
                    onClick={() => setCheckedSecrets(new Set())}
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                  >
                    Clear all
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', maxHeight: 200, overflowY: 'auto' }}>
                  {[...checkedSecrets].sort((a, b) => a.localeCompare(b)).map((s) => {
                    const staged = (drafts[s]?.length ?? 0) > 0;
                    return (
                      <span
                        key={s}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', background: 'rgba(37, 99, 235, 0.08)', border: '1px solid rgba(37, 99, 235, 0.35)', borderRadius: 999, fontSize: 12 }}
                      >
                        <code title={s} style={{ fontSize: 11.5, color: 'var(--text-main)', wordBreak: 'break-all' }}>{s}</code>
                        {staged && (
                          <span className="badge badge-sm" style={{ fontSize: 8, background: '#16a34a', color: '#fff' }} title="Already has staged entries in the cart">
                            in cart
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleChecked(s)}
                          title="Remove from selection"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1, display: 'flex' }}
                        >
                          <Icons.X size={12} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
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
                  ) : keysErrored ? (
                    // A real backend/provider error (e.g. Azure denying data-plane access to this
                    // vault even though ARM discovery lists it) — distinct from "doesn't exist" so
                    // an access-policy problem never gets misread as a naming problem.
                    <div style={{ padding: 12, borderRadius: 6, border: '1px dashed #dc2626', color: '#dc2626', fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <Icons.AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>
                        Could not check {isAzureInstance ? 'this vault' : 'this secret'}: {(keysError as any)?.message || 'request failed'}
                      </span>
                    </div>
                  ) : !existingKeysData?.exists ? (
                    <div style={{ padding: 12, borderRadius: 6, border: '1px dashed var(--border)', color: 'var(--text-muted)', fontSize: 13 }}>
                      {copy.missingTarget}
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
                                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        <span style={{ wordBreak: 'break-all' }}>{k}</span>
                                        <CopyAndUseKeyButton value={k} onUse={setNewKey} />
                                      </div>
                                    </td>
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
                      <label className="form-label" style={{ fontSize: 12 }}>
                        {isAzureInstance ? 'Key Vault Secret Name' : 'Key Name'}
                      </label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder={isAzureInstance ? 'e.g. orbit-kfin-username' : 'e.g. STRIPE_API_KEY'}
                        style={{ fontFamily: 'monospace', fontSize: 12 }}
                        value={newKey}
                        onChange={(e) => setNewKey(e.target.value)}
                      />
                    </div>
                    {keyPrecheck.blocked && keyPrecheck.matched && (
                      <AiKeyPrecheck matched={keyPrecheck.matched} keyName={newKey.trim()} sarcasmIndex={sarcasmIndex} />
                    )}
                    {isAzureInstance && (
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label" style={{ fontSize: 12 }}>
                          Environment Variable{' '}
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
                            (optional) · how the pod sees it
                          </span>
                        </label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder={
                            newKey.trim()
                              ? `optional — defaults to ${deriveEnvVar(newKey)}`
                              : 'optional — e.g. KFIN_USERNAME'
                          }
                          style={{ fontFamily: 'monospace', fontSize: 12 }}
                          value={newEnvVar}
                          onChange={(e) => setNewEnvVar(e.target.value)}
                        />
                        <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                          Not required — leave blank and Hermes derives <code>{newKey.trim() ? deriveEnvVar(newKey) : 'the name'}</code> from
                          the key. Only set this when the service expects a different name.
                        </p>
                      </div>
                    )}
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
                    <button
                      type="submit"
                      className="btn btn-outline btn-sm"
                      disabled={keyPrecheck.blocked}
                      style={{
                        alignSelf: 'flex-end',
                        marginTop: 4,
                        ...(keyPrecheck.blocked ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
                      }}
                    >
                      {keyPrecheck.blocked
                        ? 'Blocked by AI check'
                        : checkedSecrets.size > 0
                          ? `Add to ${checkedSecrets.size} secret${checkedSecrets.size > 1 ? 's' : ''}`
                          : 'Add to cart'}
                    </button>
                  </form>
                  {cartSecrets.length > 0 && (
                    <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icons.Info size={13} style={{ flexShrink: 0 }} />
                      Stage entries for as many secrets as you like — switch the {isAzureInstance ? 'target vault' : 'Target AWS Secret'} above to add another. Review and submit them all together below.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Review Cart — every secret with a non-empty basket, each with its own deployment picker */}
      {cartSecrets.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <SectionHeader
            title="Review Cart"
            icon={<Icons.ShoppingCart size={18} />}
            meta={`${cartSecrets.length} secret${cartSecrets.length > 1 ? 's' : ''} · ${totalCartKeys} key${totalCartKeys > 1 ? 's' : ''}`}
          />

          {cartSecrets.map((s) => (
            <SecretCartGroup
              key={s}
              secretName={s}
              platform={selectedPlatform}
              isAzure={isAzureInstance}
              entries={drafts[s] || []}
              onRemoveEntry={(key) => handleRemoveDraft(s, key)}
              onDiscard={() => handleDiscardSecret(s)}
              excludedTargetPaths={excludedTargetsBySecret[s] || EMPTY_PATH_SET}
              onToggleTarget={(path) => toggleTarget(s, path)}
              excludedKeysByPath={excludedKeysBySecret[s] || {}}
              onToggleKeyForPath={(path, key) => toggleKeyForPath(s, path, key)}
              manualTargets={manualTargetsBySecret[s] || []}
              onAddManualTarget={(path) => addManualTarget(s, path)}
              onRemoveManualTarget={(path) => removeManualTarget(s, path)}
              onResolved={(value) => handleResolved(s, value)}
            />
          ))}

          <div className="bulk-request-panel" style={{ marginTop: 16 }}>
            <div className="bulk-request-body" style={{ gridTemplateColumns: '1fr', gap: 12 }}>
              <div className="form-group form-row" style={{ marginBottom: 0 }}>
                <label className="form-label">Justification</label>
                <textarea
                  className="form-textarea"
                  placeholder="Why is this ingestion needed? Applies to every secret in this cart (optional)"
                  value={batchJustification}
                  onChange={(e) => setBatchJustification(e.target.value)}
                />
              </div>
            </div>

            <div className="bulk-request-footer">
              <span style={{ marginRight: 'auto', fontSize: 13, color: 'var(--text-muted)' }}>
                Submits one request per secret. Requires admin approval; merges approved keys, leaves unmentioned keys intact.
              </span>
              <button
                type="button"
                className="btn btn-primary"
                style={{ gap: 6 }}
                disabled={submitMutation.isPending || anyResolving}
                onClick={() => submitMutation.mutate()}
              >
                {submitMutation.isPending || anyResolving ? <Icons.Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Icons.Send size={16} />}
                {anyResolving
                  ? 'Resolving deployment targets…'
                  : `Submit ${cartSecrets.length} Ingestion Request${cartSecrets.length > 1 ? 's' : ''}`}
              </button>
            </div>
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
                  <th style={{ width: 64 }}>#</th>
                  <th>Secret</th>
                  <th>Keys Info</th>
                  <th style={{ width: 140 }}>Status</th>
                  <th style={{ width: 160 }}>Deployment PR</th>
                  <th style={{ width: 180 }}>Submitted</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {myRequests.map((r, idx) => {
                  // Group header before the first row of a batch (a multi-secret cart checkout).
                  // Rows without a batchId, or the second+ member of a batch, render no header.
                  const prev = idx > 0 ? myRequests[idx - 1] : undefined;
                  const isBatchStart = !!r.batchId && r.batchId !== prev?.batchId;
                  const batchSize = isBatchStart
                    ? myRequests.filter((x) => x.batchId === r.batchId).length
                    : 0;
                  return (
                    <React.Fragment key={r.id}>
                      {isBatchStart && batchSize > 1 && (
                        <tr>
                          <td colSpan={7} style={{ background: 'var(--bg-card)', padding: '6px 12px', borderTop: '2px solid var(--border)' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
                              <Icons.ShoppingCart size={13} style={{ color: 'var(--primary)' }} />
                              Batch of {batchSize} · submitted {new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </td>
                        </tr>
                      )}
                      <tr>
                        <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, color: 'var(--primary)' }}>
                          {r.requestNumber !== undefined ? `#${r.requestNumber}` : '—'}
                        </td>
                        <td title={r.secretName} style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}>{r.secretName}</td>
                        <td>
                          <details>
                            <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>
                              {r.entries.length} key(s)
                            </summary>
                            <div style={{ marginTop: 8 }}>
                              {r.entries.map((entry, i) => (
                                <div key={i} style={{ fontSize: 12, padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
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
                        <td style={{ textAlign: 'right' }}>
                          {/* PENDING only — by APPLY_FAILED some keys may already be live in the
                              secret store, so recovering that request belongs to a reviewer.
                              Withdrawing one member of a batch leaves the others alone: each
                              request in a cart checkout is independently reviewed and applied. */}
                          {r.status === 'PENDING' && (
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              onClick={() => setWithdrawing(r)}
                              disabled={withdrawMutation.isPending}
                            >
                              Withdraw
                            </button>
                          )}
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ReasonModal
        isOpen={!!withdrawing}
        title="Withdraw ingestion request"
        message={
          <>
            Withdraw request {withdrawing?.requestNumber !== undefined ? `#${withdrawing.requestNumber}` : ''} for{' '}
            <strong>{withdrawing?.secretName}</strong>? Nothing was written to the secret store, the staged
            values are discarded, and its deployment PR is closed. You'll need to re-enter the values if you
            submit again.
          </>
        }
        placeholder="Why are you withdrawing this? (optional)"
        confirmLabel="Withdraw request"
        loading={withdrawMutation.isPending}
        onConfirm={(reason) => withdrawing && withdrawMutation.mutate({ id: withdrawing.id, reason })}
        onClose={() => setWithdrawing(null)}
      />
    </div>
  );
};
