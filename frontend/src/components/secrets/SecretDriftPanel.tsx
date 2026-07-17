import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Icons from "lucide-react";
import SectionHeader from "../common/SectionHeader";
import { queryKeys } from "../../lib/queryKeys";
import { envBg, formatTargetPath } from "../../lib/infraTargetFormat";
import { useToast } from "../../contexts/ToastContext";
import {
  getSecretDrift,
  listSecretsInstances,
  mergeSecretDrift,
  resolveSecretDrift,
  type DriftFailure,
  type DriftResolveResult,
  type SecretDrift,
} from "../../services/api/secretsApi";

/**
 * Shown when some secrets could not be checked at all. Deliberately prominent: a failed check
 * produces no drift card, so without this the panel would render a reassuring "No drift detected"
 * (or a short list) while silently knowing nothing about these secrets.
 */
const DriftFailureNotice: React.FC<{ failed: DriftFailure[] }> = ({
  failed,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        border: "1px solid var(--status-rejected-text)",
        borderRadius: "var(--radius-md)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icons.AlertTriangle
          size={16}
          style={{ color: "var(--status-rejected-text)", flexShrink: 0 }}
        />
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {failed.length} secret(s) could not be checked — this report is
          incomplete
        </span>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Details"}
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
        Their drift state is unknown — not "in sync". Re-scan, and if this
        persists check the backend logs for the underlying error (a GitHub rate
        limit is the usual cause).
      </p>
      {open && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginTop: 2,
          }}
        >
          {failed.map((f) => (
            <div key={f.secretName} style={{ fontSize: 12 }}>
              <code>{f.secretName}</code>
              <span style={{ color: "var(--text-muted)" }}> — {f.error}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** Small labelled chip for a drift key list (missing-in-manifest, dangling, etc.). */
const KeyChips: React.FC<{ keys: string[]; strike?: boolean }> = ({
  keys,
  strike,
}) => (
  <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
    {keys.map((k) => (
      <code
        key={k}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          padding: "1px 6px",
          fontSize: 11,
          fontWeight: 600,
          textDecoration: strike ? "line-through" : "none",
          color: strike ? "var(--text-muted)" : "var(--text-main)",
        }}
      >
        {k}
      </code>
    ))}
  </span>
);

const DriftCard: React.FC<{
  drift: SecretDrift;
  resolved?: DriftResolveResult;
  onSolve: () => void;
  onMerge: () => void;
  solving: boolean;
  merging: boolean;
}> = ({ drift, resolved, onSolve, onMerge, solving, merging }) => {
  // `resolved` holds this secret's most recent action result — Solve or Merge — so the card walks
  // OPEN → MERGED / FAILED as the admin works through it.
  const merged = resolved?.state === "MERGED";
  const mergeFailed = resolved?.state === "FAILED";
  // SKIPPED (nothing left to register) and CLOSED (keys already on base, or no manifest could be
  // edited) both mean the PR this card knew about is gone. Any `openPr` from the scan is stale in
  // that case, so fall back to Solve — re-opening a PR is the real next action, not merging.
  const prGone = resolved?.state === "SKIPPED" || resolved?.state === "CLOSED";
  const prNumber = resolved?.prNumber ?? drift.openPr?.number ?? null;
  const prUrl = resolved?.prUrl ?? drift.openPr?.url ?? null;
  // Merging is offered whenever a PR is waiting — one we just opened, one a previous session left
  // behind, or one whose merge failed and can be retried. Drift never merges itself, whatever the
  // auto-merge setting says (see secret-drift.service.ts resolveDrift): a drift PR is raised by a
  // scan, not proposed by a person, so it always waits here for someone to read the diff first.
  const canMerge =
    !merged &&
    !prGone &&
    (resolved?.state === "OPEN" || mergeFailed || !!drift.openPr);
  return (
    <div className="table-container" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 10.5,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: ".05em",
              fontWeight: 600,
            }}
          >
            AWS Secret · {drift.groupName}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: "3px 0 4px",
              flexWrap: "wrap",
            }}
          >
            <Icons.KeyRound
              size={16}
              style={{ color: "var(--primary)", flexShrink: 0 }}
            />
            <code
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: "var(--text-main)",
                wordBreak: "break-all",
              }}
            >
              {drift.secretName}
            </code>
            {!drift.awsExists && (
              <span
                className="badge badge-sm"
                style={{
                  background: "#dc2626",
                  color: "#fff",
                  fontSize: 9,
                  fontWeight: 700,
                }}
                title="This secret does not exist in AWS Secrets Manager"
              >
                MISSING IN AWS
              </span>
            )}
            {drift.awsExists && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {drift.awsKeyCount} key(s) in AWS
              </span>
            )}
          </div>
        </div>
        {drift.fixable && (
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            {merged ? (
              <span
                className="badge badge-sm"
                style={{
                  background: "var(--status-approved-text)",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <Icons.CheckCircle2 size={12} /> Merged
              </span>
            ) : canMerge ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ gap: 6 }}
                disabled={merging}
                onClick={onMerge}
                title={
                  mergeFailed
                    ? "Retry merging the reconciliation PR"
                    : "Merge the reconciliation PR — review it on GitHub first"
                }
              >
                {merging ? (
                  <Icons.Loader
                    size={14}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                ) : (
                  <Icons.GitMerge size={14} />
                )}
                {mergeFailed ? "Retry merge" : "Merge PR"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ gap: 6 }}
                disabled={solving}
                onClick={onSolve}
                title="Open a draft infra-deployment PR registering the missing keys"
              >
                {solving ? (
                  <Icons.Loader
                    size={14}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                ) : (
                  <Icons.GitPullRequestArrow size={14} />
                )}
                Solve drift
              </button>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* Fixable: AWS keys missing from the manifests */}
        {drift.missingInManifest.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 12,
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(217, 119, 6, 0.06)",
              border: "1px solid rgba(217, 119, 6, 0.25)",
            }}
          >
            <Icons.AlertTriangle
              size={14}
              style={{ color: "#d97706", flexShrink: 0, marginTop: 2 }}
            />
            <div>
              <strong style={{ color: "#b45309" }}>
                Not registered in the manifests
              </strong>{" "}
              — the CSI driver won't sync these to the pods:
              <div style={{ marginTop: 5 }}>
                <KeyChips keys={drift.missingInManifest} />
              </div>
            </div>
          </div>
        )}

        {/* Dangling: registered in a manifest but absent from AWS */}
        {drift.missingInAws.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 12,
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(220, 38, 38, 0.05)",
              border: "1px solid rgba(220, 38, 38, 0.22)",
            }}
          >
            <Icons.Unlink
              size={14}
              style={{ color: "#dc2626", flexShrink: 0, marginTop: 2 }}
            />
            <div style={{ minWidth: 0 }}>
              <strong style={{ color: "#b91c1c" }}>
                Registered but missing from AWS
              </strong>{" "}
              — dangling references (add the value in AWS, or remove them from
              the manifest):
              <div style={{ marginTop: 5 }}>
                <KeyChips keys={drift.missingInAws} strike />
              </div>
            </div>
          </div>
        )}

        {/* Unmatched: referenced but structure unparseable */}
        {drift.unmatchedManifests.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 12,
              padding: "8px 10px",
              borderRadius: 6,
              background: "var(--bg-inset)",
              border: "1px solid var(--border)",
            }}
          >
            <Icons.FileWarning
              size={14}
              style={{
                color: "var(--text-muted)",
                flexShrink: 0,
                marginTop: 2,
              }}
            />
            <div>
              Referenced in {drift.unmatchedManifests.length} manifest(s) whose
              key-list structure couldn't be parsed — register keys there
              manually:
              <div
                style={{
                  marginTop: 4,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {drift.unmatchedManifests.map((p) => (
                  <code key={p} style={{ fontSize: 11 }}>
                    {formatTargetPath(p).display}
                  </code>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Consuming manifests overview */}
        {drift.manifests.length > 0 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              paddingTop: 2,
            }}
          >
            {drift.manifests.map((m) => (
              <div
                key={m.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  flexWrap: "wrap",
                }}
              >
                <span
                  className="badge badge-sm"
                  style={{
                    textTransform: "uppercase",
                    fontSize: 9,
                    fontWeight: 700,
                    background: envBg(m.env),
                    color: "#fff",
                  }}
                >
                  {m.env}
                </span>
                <span className="badge badge-sm" style={{ fontSize: 9 }}>
                  {m.format === "spc" ? "SPC" : "values"}
                </span>
                <code
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatTargetPath(m.path).display}
                </code>
                {m.missingKeys.length > 0 && (
                  <span
                    style={{
                      fontSize: 9.5,
                      color: "#b45309",
                      fontStyle: "italic",
                    }}
                  >
                    missing: {m.missingKeys.join(", ")}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Hermes could not merge it. The PR is intact and still mergeable by hand, so quote
            GitHub's reason and point at the PR rather than dead-ending on a toast the admin has
            already dismissed. The button above stays live as a retry for transient causes. */}
        {mergeFailed && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 12,
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(220, 38, 38, 0.05)",
              border: "1px solid rgba(220, 38, 38, 0.22)",
            }}
          >
            <Icons.GitPullRequestClosed
              size={14}
              style={{ color: "#dc2626", flexShrink: 0, marginTop: 2 }}
            />
            <div style={{ minWidth: 0 }}>
              <strong style={{ color: "#b91c1c" }}>
                Hermes couldn't merge this PR
              </strong>
              {resolved?.note ? (
                <div style={{ marginTop: 3, color: "var(--text-muted)" }}>
                  {resolved.note}
                </div>
              ) : null}
              <div style={{ marginTop: 3, color: "var(--text-muted)" }}>
                The PR itself is fine — merge it on GitHub, or retry once the
                blocker is cleared.
              </div>
            </div>
          </div>
        )}

        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-outline btn-sm"
            style={{
              alignSelf: "flex-start",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              textDecoration: "none",
            }}
          >
            <Icons.ExternalLink size={12} />
            {merged
              ? "View merged PR"
              : mergeFailed
                ? "Merge on GitHub"
                : "Review PR"}
            {prNumber ? ` #${prNumber}` : ""}
          </a>
        )}
      </div>
    </div>
  );
};

export const SecretDriftPanel: React.FC = () => {
  const toast = useToast();
  const [platform, setPlatform] = useState<string>("secrets");
  // On-demand: a drift scan reads AWS + GitHub, so don't run it on mount — the admin clicks Scan.
  const [scanned, setScanned] = useState(false);
  const [resolvedBySecret, setResolvedBySecret] = useState<
    Record<string, DriftResolveResult>
  >({});

  const { data: instances = [] } = useQuery({
    queryKey: queryKeys.secretsInstances(),
    queryFn: listSecretsInstances,
  });
  const multiInstance = instances.length > 1;

  const {
    data: report,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: queryKeys.secretDrift(platform),
    queryFn: () => getSecretDrift(platform),
    enabled: scanned,
  });

  const solveMutation = useMutation({
    mutationFn: (secretName: string) =>
      resolveSecretDrift(secretName, platform),
    onSuccess: (result) => {
      setResolvedBySecret((prev) => ({ ...prev, [result.secretName]: result }));
      if (result.state === "OPEN") {
        toast.success(
          `Draft PR opened${result.prNumber ? ` (#${result.prNumber})` : ""} — review it on GitHub, then merge it from here or there.`,
        );
      } else if (result.state === "SKIPPED") {
        toast.info(result.note || "Nothing to reconcile.");
      } else {
        toast.info(
          `Reconciliation ${result.state.toLowerCase()}.${result.note ? ` ${result.note}` : ""}`,
        );
      }
    },
    onError: (err: any) =>
      toast.error(err?.message || "Failed to reconcile drift."),
  });

  const mergeMutation = useMutation({
    mutationFn: (secretName: string) => mergeSecretDrift(secretName, platform),
    onSuccess: (result) => {
      setResolvedBySecret((prev) => ({ ...prev, [result.secretName]: result }));
      if (result.state === "MERGED") {
        toast.success(
          `PR${result.prNumber ? ` #${result.prNumber}` : ""} merged — the missing keys are now registered in the manifests.`,
        );
      } else if (result.state === "FAILED") {
        // GitHub refused (an unmergeable token, branch protection, a pending check). This
        // resolves rather than throws, so surface the reason — the card keeps the PR link and
        // the retry button alongside it.
        toast.error(result.note || "GitHub refused the merge — see the PR.");
      } else if (result.state === "SKIPPED") {
        toast.info(result.note || "Nothing left to merge.");
      } else {
        toast.info(
          `Merge ${result.state.toLowerCase()}.${result.note ? ` ${result.note}` : ""}`,
        );
      }
    },
    onError: (err: any) => toast.error(err?.message || "Failed to merge PR."),
  });

  const runScan = () => {
    setScanned(true);
    setResolvedBySecret({});
    // enabled flips to true on the first scan; an explicit refetch covers re-scans.
    if (scanned) refetch();
  };

  const switchPlatform = (key: string) => {
    setPlatform(key);
    setResolvedBySecret({});
  };

  const drifts = report?.drifts ?? [];
  // A secret whose check threw contributes no drift entry, so an empty `drifts` alongside a
  // non-empty `failed` means "we don't know", not "all in sync" — the UI must not conflate them.
  const failed = report?.failed ?? [];

  return (
    <div style={{ marginTop: 36 }}>
      <SectionHeader
        title="Secret Drift"
        icon={<Icons.GitCompareArrows size={18} />}
        meta="AWS Secrets Manager ⇄ infra-deployment"
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        {multiInstance && (
          <div
            style={{
              display: "inline-flex",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              overflow: "hidden",
            }}
          >
            {instances.map((inst) => {
              const active = inst.key === platform;
              return (
                <button
                  key={inst.key}
                  type="button"
                  onClick={() => switchPlatform(inst.key)}
                  style={{
                    padding: "6px 14px",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    border: "none",
                    background: active ? "var(--primary)" : "transparent",
                    color: active ? "#fff" : "var(--text-muted)",
                  }}
                >
                  {inst.label}
                </button>
              );
            })}
          </div>
        )}
        <button
          type="button"
          className="btn btn-outline btn-sm"
          style={{ gap: 6 }}
          onClick={runScan}
          disabled={isFetching}
        >
          {isFetching ? (
            <Icons.Loader
              size={14}
              style={{ animation: "spin 1s linear infinite" }}
            />
          ) : (
            <Icons.RefreshCw size={14} />
          )}
          {scanned ? "Re-scan" : "Scan for drift"}
        </button>
        {report && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {report.scannedSecretCount - failed.length} of{" "}
            {report.scannedSecretCount} secret(s) checked ·{" "}
            {new Date(report.generatedAt).toLocaleTimeString()}
            {report.truncated ? " · capped (some secrets not checked)" : ""}
          </span>
        )}
      </div>

      {!scanned ? (
        <div className="empty-state empty-state-compact">
          <Icons.GitCompareArrows size={22} className="empty-state-icon" />
          <div>
            <p className="empty-state-desc" style={{ margin: 0 }}>
              Check whether the keys stored in AWS Secrets Manager match what
              the infra-deployment manifests register for the pods.
            </p>
          </div>
        </div>
      ) : isFetching && !report ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--text-muted)",
            fontSize: 13,
            padding: "8px 2px",
          }}
        >
          <Icons.Loader
            size={15}
            style={{ animation: "spin 1s linear infinite" }}
          />
          Scanning secrets…
        </div>
      ) : report && !report.infraEnabled ? (
        <div className="empty-state empty-state-compact">
          <Icons.Info size={22} className="empty-state-icon" />
          <p className="empty-state-desc" style={{ margin: 0 }}>
            No infra-deployment repo is configured for this instance, so there
            are no manifests to compare against.
          </p>
        </div>
      ) : drifts.length === 0 && failed.length === 0 ? (
        <div className="empty-state empty-state-compact">
          <Icons.CheckCircle2
            size={22}
            className="empty-state-icon"
            style={{ color: "var(--status-approved-text)" }}
          />
          <div>
            <h3 className="empty-state-title">No drift detected</h3>
            <p className="empty-state-desc">
              Every in-scope secret's keys match the infra-deployment manifests.
            </p>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {failed.length > 0 && <DriftFailureNotice failed={failed} />}
          {drifts.map((d) => (
            <DriftCard
              key={d.secretName}
              drift={d}
              resolved={resolvedBySecret[d.secretName]}
              solving={
                solveMutation.isPending &&
                solveMutation.variables === d.secretName
              }
              onSolve={() => solveMutation.mutate(d.secretName)}
              onMerge={() => mergeMutation.mutate(d.secretName)}
              merging={
                mergeMutation.isPending &&
                mergeMutation.variables === d.secretName
              }
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default SecretDriftPanel;
