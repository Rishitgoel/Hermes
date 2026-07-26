import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import LoadingSpinner from '../common/LoadingSpinner';
import SectionHeader from '../common/SectionHeader';
import Switch from '../common/Switch';
import { queryKeys } from '../../lib/queryKeys';
import {
  getSystemSettings,
  updateSystemSetting,
  type SystemSettingRecord,
} from '../../services/api/admin';

/**
 * Per-platform infra behaviour. Today that is just the Secret Ingestion
 * auto-merge choice, which used to live in a modal reachable only from a button
 * on the Admin Management page.
 */
export const PlatformSettingsTab: React.FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery<SystemSettingRecord[]>({
    queryKey: queryKeys.adminSystemSettings(),
    queryFn: getSystemSettings,
  });

  const mutation = useMutation({
    mutationFn: ({
      platformKey,
      autoMergeEnabled,
    }: {
      platformKey: string;
      autoMergeEnabled: boolean;
    }) => updateSystemSetting(platformKey, autoMergeEnabled),
    onSuccess: (data) => {
      toast.success(`Updated auto-merge setting for ${data.platformKey}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.adminSystemSettings() });
    },
    onError: (e: any) => {
      toast.error(e.message || 'Failed to update setting');
      queryClient.invalidateQueries({ queryKey: queryKeys.adminSystemSettings() });
    },
  });

  return (
    <div>
      <SectionHeader
        title="Secret Ingestion — PR merge"
        icon={<Icons.GitMerge size={18} />}
        description="Whether approved key additions are squash-merged automatically, or left open as draft PRs for manual review on GitHub."
      />

      <div className="settings-note is-muted" style={{ marginBottom: 14 }}>
        <Icons.Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          This applies to Secret Ingestion approvals only. Secret Drift always opens a draft PR and
          waits for you to review it and click <strong>Merge PR</strong> — a drift PR is raised by a
          scan rather than proposed by someone, so it never merges unattended.
        </span>
      </div>

      {settingsQuery.isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '30px 0' }}>
          <LoadingSpinner message="Loading settings…" />
        </div>
      ) : settingsQuery.isError ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Icons.AlertTriangle size={28} />
          </div>
          <div className="empty-state-title">Could not load platform settings</div>
          <div className="empty-state-desc">
            {(settingsQuery.error as any)?.message || 'Make sure you have administrative access.'}
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            style={{ marginTop: 12 }}
            onClick={() => settingsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : !settingsQuery.data || settingsQuery.data.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Icons.Package size={28} />
          </div>
          <div className="empty-state-title">No Secret Ingestion instances</div>
          <div className="empty-state-desc">There is nothing to configure here yet.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {settingsQuery.data.map((item) => (
            <div
              key={item.platformKey}
              className="settings-card"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                padding: '12px 16px',
                backgroundColor: 'var(--bg-inset)',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="notify-name">{item.platformLabel}</div>
                <div className="notify-desc">Key: {item.platformKey}</div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: item.autoMergeEnabled ? 'var(--primary)' : 'var(--text-muted)',
                  }}
                >
                  {item.autoMergeEnabled ? 'Auto-merge' : 'Manual-merge'}
                </span>
                <Switch
                  aria-label={`Auto-merge for ${item.platformLabel}`}
                  checked={item.autoMergeEnabled}
                  disabled={mutation.isPending}
                  onChange={(checked) =>
                    mutation.mutate({ platformKey: item.platformKey, autoMergeEnabled: checked })
                  }
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PlatformSettingsTab;
