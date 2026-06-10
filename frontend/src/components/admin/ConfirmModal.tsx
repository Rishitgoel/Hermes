import React from 'react';
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
  onConfirm,
  onClose,
}) => {
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
            disabled={loading}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{message}</div>
    </Modal>
  );
};

export default ConfirmModal;
