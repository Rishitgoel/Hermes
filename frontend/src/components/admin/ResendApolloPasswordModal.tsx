import React, { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import {
  resendApolloPassword,
  type RegeneratePasswordResult,
} from '../../services/api/apolloUsers';
import TemporaryPasswordPanel from './TemporaryPasswordPanel';

interface ResendApolloPasswordModalProps {
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

/** Matches the create dialog — every Apollo login is a Bachatt address. */
const DEFAULT_EMAIL_DOMAIN = '@bachatt.app';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Regenerate an existing Apollo login's temporary password and re-send it.
 *
 * The recovery path for a password that never reached its owner — a failed Slack
 * DM, or a reveal dialog closed without saving it. Restricted server-side to
 * accounts Hermes created, so this is not a general "reset anyone's password"
 * tool; the backend returns 403 with an explanation otherwise.
 */
export const ResendApolloPasswordModal: React.FC<ResendApolloPasswordModalProps> = ({
  onClose,
  onDone,
  onError,
}) => {
  const [email, setEmail] = useState(DEFAULT_EMAIL_DOMAIN);
  const [result, setResult] = useState<RegeneratePasswordResult | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);

  // Pre-seeded with the domain, so put the caret before it — they type the local part.
  useEffect(() => {
    emailInputRef.current?.focus();
    emailInputRef.current?.setSelectionRange(0, 0);
  }, []);

  const resendMutation = useMutation({
    mutationFn: () => resendApolloPassword(email.trim()),
    onSuccess: (data) => {
      setResult(data);
      // Delivered cleanly — nothing left for the admin to do here.
      if (data.slack.delivered) {
        onDone(`A new temporary password was sent to ${data.email} on Slack.`);
        onClose();
      }
    },
    onError: (e: any) => onError(e.message || 'Failed to regenerate the password.'),
  });

  const emailValid = EMAIL_RE.test(email.trim());
  const passwordOnScreen = !!result?.temporaryPassword;

  const submit = () => {
    if (emailValid && !resendMutation.isPending && !result) {
      resendMutation.mutate();
    }
  };

  // Never dismiss by accident while the only copy of a password is visible.
  const requestClose = () => {
    if (!passwordOnScreen) {
      onClose();
    }
  };

  const finish = () => {
    if (result) {
      onDone(`New temporary password issued for ${result.email}.`);
    }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '560px' }}>
        <div className="modal-header" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="modal-title">Resend Apollo password</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.4 }}>
              Generates a new temporary password and DMs it on Slack. Their previous password stops
              working immediately.
            </div>
          </div>
          {!passwordOnScreen && (
            <button type="button" className="modal-close-btn" onClick={onClose}>
              <Icons.X size={20} />
            </button>
          )}
        </div>

        <div className="modal-body">
          {result ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '6px 14px',
                  fontSize: '13px',
                  alignItems: 'center',
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>Email</span>
                <strong>{result.email}</strong>
                <span style={{ color: 'var(--text-muted)' }}>Username</span>
                <strong>{result.username}</strong>
              </div>

              {result.temporaryPassword ? (
                <TemporaryPasswordPanel
                  password={result.temporaryPassword}
                  slack={result.slack}
                  onCopyError={onError}
                />
              ) : (
                <div
                  className="banner banner-success"
                  style={{ fontSize: '12.5px', marginBottom: 0, fontWeight: 500, alignItems: 'flex-start' }}
                >
                  <Icons.CheckCircle2 size={14} style={{ flexShrink: 0 }} />
                  <span>A new temporary password was sent to {result.email} on Slack.</span>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div
                className="banner banner-warning"
                style={{ fontSize: '12.5px', marginBottom: 0, fontWeight: 500, alignItems: 'flex-start' }}
              >
                <Icons.AlertTriangle size={14} style={{ flexShrink: 0 }} />
                <span>
                  Only works for accounts created through Hermes. Any password this person already
                  has will stop working.
                </span>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Work email</label>
                <input
                  ref={emailInputRef}
                  className="form-input"
                  type="email"
                  value={email}
                  placeholder="firstname.lastname@bachatt.app"
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                />
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          {result ? (
            <button type="button" className="btn btn-primary" onClick={finish}>
              {passwordOnScreen ? "I've saved the password — done" : 'Done'}
            </button>
          ) : (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" className="btn btn-outline" onClick={onClose} disabled={resendMutation.isPending}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!emailValid || resendMutation.isPending}
                style={
                  !emailValid
                    ? { background: 'var(--bg-inset)', color: 'var(--text-light)', boxShadow: 'none' }
                    : undefined
                }
                onClick={submit}
              >
                {resendMutation.isPending ? 'Generating…' : 'Regenerate & send'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ResendApolloPasswordModal;
