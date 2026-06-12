import React, { useEffect, useState } from 'react';
import Modal from './Modal';

/**
 * Confirm dialog that also collects a free-text reason — replaces window.prompt
 * for destructive actions like revoking access. Owns its textarea state and
 * resets it every time it opens.
 */
interface ReasonModalProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** When true, the confirm button stays disabled until a non-empty reason is typed. */
  requireReason?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

export const ReasonModal: React.FC<ReasonModalProps> = ({
  isOpen,
  title,
  message,
  placeholder = 'Reason (optional)…',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  requireReason = false,
  onConfirm,
  onClose,
}) => {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (isOpen) setReason('');
  }, [isOpen]);

  const canConfirm = !loading && (!requireReason || reason.trim().length > 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={
              danger
                ? { background: 'var(--status-rejected-text)', borderColor: 'var(--status-rejected-text)' }
                : undefined
            }
            onClick={() => onConfirm(reason.trim())}
            disabled={!canConfirm}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '14px' }}>{message}</div>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label">Reason</label>
        <textarea
          className="form-textarea"
          style={{ minHeight: '70px' }}
          placeholder={placeholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={loading}
          autoFocus
        />
      </div>
    </Modal>
  );
};

export default ReasonModal;
