import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import LoadingSpinner from '../common/LoadingSpinner';
import { getSystemSettings, updateSystemSetting, type SystemSettingRecord } from '../../services/api/admin';

interface MergeSettingsModalProps {
  onClose: () => void;
}

export const MergeSettingsModal: React.FC<MergeSettingsModalProps> = ({ onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading, error } = useQuery<SystemSettingRecord[]>({
    queryKey: ['adminSettings'],
    queryFn: getSystemSettings,
  });

  const mutation = useMutation({
    mutationFn: ({ platformKey, autoMergeEnabled }: { platformKey: string; autoMergeEnabled: boolean }) =>
      updateSystemSetting(platformKey, autoMergeEnabled),
    onSuccess: (data) => {
      toast.success(`Updated auto-merge setting for ${data.platformKey}`);
      queryClient.invalidateQueries({ queryKey: ['adminSettings'] });
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to update setting');
    },
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--primary)',
              }}
            >
              <Icons.GitMerge size={18} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text-light)' }}>PR Merge Settings</h3>
              <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-muted)' }}>Configure infra-deployment PR merge preferences</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              display: 'flex',
              padding: '4px',
              borderRadius: '4px',
            }}
            className="hover-bg-inset"
          >
            <Icons.X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ padding: '20px', overflowY: 'auto' }}>
          <p style={{ margin: '0 0 20px', fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
            Choose whether approved key additions are squash-merged automatically by Hermes or left open as draft PRs for manual review on GitHub.
          </p>
          <p style={{ margin: '-10px 0 20px', fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
            This applies to Secret Ingestion approvals only. Secret Drift always opens a draft PR
            and waits for you to review it and click <strong>Merge PR</strong> — a drift PR is
            raised by a scan rather than proposed by someone, so it never merges unattended.
          </p>

          {isLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '30px 0' }}>
              <LoadingSpinner message="Loading settings..." />
            </div>
          ) : error ? (
            <div className="alert alert-danger" style={{ fontSize: '13px' }}>
              Failed to load settings. Make sure you have administrative access.
            </div>
          ) : !settings || settings.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px 0', fontSize: '13px' }}>
              No Secret Ingestion instances available to manage.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {settings.map((item) => (
                <div
                  key={item.platformKey}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg-inset)',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1, marginRight: '16px' }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-light)' }}>
                      {item.platformLabel}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'capitalize' }}>
                      Key: {item.platformKey}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 500, color: item.autoMergeEnabled ? 'var(--primary)' : 'var(--text-muted)' }}>
                      {item.autoMergeEnabled ? 'Auto-merge' : 'Manual-merge'}
                    </span>
                    <label className="switch" style={{ position: 'relative', display: 'inline-block', width: '38px', height: '20px' }}>
                      <input
                        type="checkbox"
                        checked={item.autoMergeEnabled}
                        onChange={(e) => mutation.mutate({ platformKey: item.platformKey, autoMergeEnabled: e.target.checked })}
                        disabled={mutation.isPending}
                        style={{ opacity: 0, width: 0, height: 0 }}
                      />
                      <span
                        className="slider"
                        style={{
                          position: 'absolute',
                          cursor: 'pointer',
                          top: 0,
                          left: 0,
                          right: 0,
                          bottom: 0,
                          backgroundColor: item.autoMergeEnabled ? 'var(--primary)' : '#ccc',
                          transition: '.4s',
                          borderRadius: '20px',
                        }}
                      >
                        <span
                          style={{
                            position: 'absolute',
                            content: '""',
                            height: '14px',
                            width: '14px',
                            left: '3px',
                            bottom: '3px',
                            backgroundColor: 'white',
                            transition: '.4s',
                            transform: item.autoMergeEnabled ? 'translateX(18px)' : 'translateX(0)',
                            borderRadius: '50%',
                            display: 'block',
                          }}
                        />
                      </span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default MergeSettingsModal;
