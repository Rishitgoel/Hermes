import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { queryKeys } from '../../lib/queryKeys';
import Modal from '../common/Modal';
import LoadingSpinner from '../common/LoadingSpinner';
import { resyncRedashMemberships, type RedashResyncReport } from '../../services/api/admin';

/**
 * Redash Full Resync — two-way reconciliation against live Redash membership.
 * The fix for "someone edited Redash directly and now Hermes is out of sync"
 * (stuck members, orphaned grants, moved levels, disabled accounts). Manually
 * triggered — not a cron job. Opened from a "Sync" button beside "New group"
 * on the Admin Management page (super admin + Redash/Redash-QA only).
 */
interface RedashResyncModalProps {
  platform: string;
  onClose: () => void;
}

export const RedashResyncModal: React.FC<RedashResyncModalProps> = ({ platform, onClose }) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const displayName = platform === 'redash-qa' ? 'Redash QA' : 'Redash';

  const [report, setReport] = useState<RedashResyncReport | null>(null);

  const mutation = useMutation({
    mutationFn: (vars: { apply: boolean; force?: boolean }) =>
      resyncRedashMemberships(vars.apply, platform, vars.force ?? false),
    onSuccess: (r) => {
      setReport(r);
      if (r.apply && r.removePassBlockedBySafetyCap) {
        toast.error(
          `Resync applied +${r.grantsCreated}/swapped ${r.levelsSwapped}, but ${r.grantsDeactivated} deactivation(s) were blocked by the safety cap (>${r.removePassSafetyCapThreshold}). Re-run with force to proceed.`,
        );
      } else {
        toast.success(
          r.apply
            ? `Resync applied: +${r.grantsCreated} grant(s), −${r.grantsDeactivated} grant(s), ⇄${r.levelsSwapped} swap(s), ${r.requestsReconciled} request(s) unstuck.`
            : `Dry run: would add ${r.grantsCreated}, deactivate ${r.grantsDeactivated}, swap ${r.levelsSwapped}, unstick ${r.requestsReconciled}.`,
        );
      }
      if (r.apply) {
        queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(platform) });
        queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
      }
    },
    onError: (e: any) => toast.error(e.message || 'Redash resync failed.'),
  });

  return (
    <Modal isOpen onClose={onClose} title={`Sync with ${displayName}`} size="lg">
      <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Reconciles Hermes against live {displayName} membership: adds grants for memberships Hermes is missing, removes grants
        for users no longer in the group or disabled on {displayName}, swaps a grant to a different level when the user moved
        directly on {displayName}, repairs stale ids, and unsticks requests waiting on a membership that's actually already
        there. Run <strong>Dry run</strong> to preview, then <strong>Apply</strong> to write. Idempotent — safe to re-run.
      </p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ apply: false })}
        >
          <Icons.Eye size={15} /> Dry run
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={mutation.isPending}
          onClick={() => {
            if (
              window.confirm(
                `Apply full resync for ${displayName}? This creates, deactivates, swaps, and unsticks grants/requests to match live ${displayName} membership. It is idempotent (safe to re-run), but real.`,
              )
            ) {
              mutation.mutate({ apply: true });
            }
          }}
        >
          <Icons.RefreshCw size={15} /> Apply resync
        </button>
      </div>

      {mutation.isPending && <LoadingSpinner />}

      {report && (
        <div className="table-container" style={{ padding: '12px' }}>
          <div style={{ marginBottom: '8px' }}>
            <strong>{report.apply ? 'Applied' : 'Dry run'}</strong> — mapped groups: {report.mappedGroups}, cached{' '}
            {displayName} users: {report.cachedUsers}, matched to Keycloak: {report.usersMatched}
            <br />
            grants {report.apply ? 'created' : 'to create'}: {report.grantsCreated}, already present: {report.grantsAlreadyPresent},
            account requests {report.apply ? 'created' : 'to create'}: {report.accountRequestsCreated}
            <br />
            grants {report.apply ? 'deactivated' : 'to deactivate'}: {report.grantsDeactivated}
            {report.grantsDeactivatedDisabled > 0 ? ` (${report.grantsDeactivatedDisabled} disabled)` : ''}, level swaps{' '}
            {report.apply ? 'applied' : 'to apply'}: {report.levelsSwapped}, external id{' '}
            {report.apply ? 'refreshes' : 'refreshes to apply'}: {report.externalUserIdsRefreshed}, requests{' '}
            {report.apply ? 'reconciled' : 'to reconcile'}: {report.requestsReconciled}
          </div>

          {report.removePassSkippedEmptyCache && (
            <div style={{ color: 'var(--status-rejected-text, #c0392b)' }}>
              ⚠ The remove pass was skipped — the {displayName} user cache came back empty after refresh, so no grants were
              deactivated (safety guard).
            </div>
          )}
          {report.removePassSkippedUnhealthy && (
            <div style={{ color: 'var(--status-rejected-text, #c0392b)' }}>
              ⚠ The remove pass was skipped — the {displayName} health check failed
              {report.removePassUnhealthyMessage ? ` (${report.removePassUnhealthyMessage})` : ''}, so no grants were
              deactivated (safety guard).
            </div>
          )}
          {report.removePassBlockedBySafetyCap && (
            <div
              style={{
                color: 'var(--status-rejected-text, #c0392b)',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                padding: '8px 0',
              }}
            >
              <span>
                ⚠ {report.grantsDeactivated} grant(s) would be deactivated, over the safety cap of{' '}
                {report.removePassSafetyCapThreshold}. {report.apply ? 'Nothing was deactivated this run.' : ''} A partial/bad{' '}
                {displayName} fetch can look exactly like this — double-check the list below before forcing.
              </span>
              <button
                type="button"
                className="btn btn-outline btn-danger-outline btn-sm"
                disabled={mutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Force-apply the remove pass? This will deactivate ${report.grantsDeactivated} grant(s), above the normal safety cap of ${report.removePassSafetyCapThreshold}. Only do this if you've verified the list below is correct.`,
                    )
                  ) {
                    mutation.mutate({ apply: true, force: true });
                  }
                }}
              >
                Force apply anyway
              </button>
            </div>
          )}
          {report.errors.length > 0 && (
            <details style={{ marginTop: '6px' }} open>
              <summary style={{ color: 'var(--status-rejected-text, #c0392b)' }}>{report.errors.length} error(s) during this run</summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.errors.join('\n')}</pre>
            </details>
          )}
          {report.deactivatedGrants.length > 0 && (
            <details style={{ marginTop: '6px' }} open>
              <summary>
                {report.deactivatedGrants.length} grant(s) {report.apply && !report.removePassBlockedBySafetyCap ? 'deactivated' : 'would be deactivated'}
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.deactivatedGrants.join('\n')}</pre>
            </details>
          )}
          {report.swappedGrants.length > 0 && (
            <details style={{ marginTop: '6px' }} open>
              <summary>
                {report.swappedGrants.length} grant(s) {report.apply ? 'swapped to a different level' : 'would be swapped to a different level'}
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.swappedGrants.join('\n')}</pre>
            </details>
          )}
          {report.refreshedExternalUserIds.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary>
                {report.refreshedExternalUserIds.length} grant(s) with a stale external id {report.apply ? 'refreshed' : 'that would be refreshed'} (user
                deleted + recreated on {displayName})
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.refreshedExternalUserIds.join('\n')}</pre>
            </details>
          )}
          {report.reconciledRequests.length > 0 && (
            <details style={{ marginTop: '6px' }} open>
              <summary>
                {report.reconciledRequests.length} stuck request(s) {report.apply ? 'reconciled' : 'would be reconciled'}
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.reconciledRequests.join('\n')}</pre>
            </details>
          )}
          {report.stuckReported.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary>{report.stuckReported.length} stuck request(s) could not be auto-resolved</summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.stuckReported.join('\n')}</pre>
            </details>
          )}
          {report.accountRequestDrift.length > 0 && (
            <details style={{ marginTop: '6px' }} open>
              <summary style={{ color: 'var(--status-pending-text, #b9770e)' }}>
                {report.accountRequestDrift.length} account request(s) disagree with {displayName} reality — review needed
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.accountRequestDrift.join('\n')}</pre>
            </details>
          )}
          {report.usersSkippedNoKeycloak.length > 0 && (
            <div style={{ color: 'var(--status-pending-text, #b9770e)' }}>
              Skipped (no Keycloak identity): {report.usersSkippedNoKeycloak.join(', ')}
            </div>
          )}
          {report.usersSkippedDisabled.length > 0 && (
            <div style={{ color: 'var(--status-pending-text, #b9770e)' }}>
              Skipped (disabled in {displayName}): {report.usersSkippedDisabled.join(', ')}
            </div>
          )}
          {report.membershipsUnmapped.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary>{report.membershipsUnmapped.length} unmapped membership(s)</summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.membershipsUnmapped.join('\n')}</pre>
            </details>
          )}
          {report.activeGrantsSkippedUnmapped.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary>{report.activeGrantsSkippedUnmapped.length} active grant(s) skipped (unmapped group)</summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.activeGrantsSkippedUnmapped.join('\n')}</pre>
            </details>
          )}
          {report.levelConflicts.length > 0 && (
            <details style={{ marginTop: '6px' }}>
              <summary>{report.levelConflicts.length} level conflict(s) resolved by seniority</summary>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{report.levelConflicts.join('\n')}</pre>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
};

export default RedashResyncModal;
