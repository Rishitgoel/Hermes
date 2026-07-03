import React, { useEffect, useState } from 'react';
import Modal from '../common/Modal';

/**
 * Small reusable confirm dialog, built on the shared Modal. Replaces window.confirm
 * across Admin Management so destructive actions match the app's modal pattern.
 */
interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /**
   * For irreversible actions (e.g. permanently deleting an AWS account): require
   * the admin to type this exact text (case-insensitive, trimmed) before Confirm
   * enables. Omit for a normal confirm/cancel dialog.
   */
  requireTypedConfirmation?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  requireTypedConfirmation,
  onConfirm,
  onClose,
}) => {
  const [typed, setTyped] = useState('');

  // Reset the typed text whenever the dialog closes, so it doesn't carry over
  // (pre-armed) into the next confirmation it's reused for.
  useEffect(() => {
    if (!isOpen) setTyped('');
  }, [isOpen]);

  const typedConfirmed =
    !requireTypedConfirmation ||
    typed.trim().toLowerCase() === requireTypedConfirmation.trim().toLowerCase();

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
            onClick={onConfirm}
            disabled={loading || !typedConfirmed}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{message}</div>
      {requireTypedConfirmation && (
        <div style={{ marginTop: '14px' }}>
          <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>
            Type <strong>{requireTypedConfirmation}</strong> to confirm
          </label>
          <input
            type="text"
            className="form-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            autoComplete="off"
          />
        </div>
      )}
    </Modal>
  );
};

export default ConfirmModal;
