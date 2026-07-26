import React, { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import {
  createApolloUser,
  type CreateApolloUserResult,
} from '../../services/api/apolloUsers';
import TemporaryPasswordPanel from './TemporaryPasswordPanel';

interface CreateApolloUserModalProps {
  onClose: () => void;
  onCreated: (message: string) => void;
  onError: (message: string) => void;
}

/** Every Apollo login is a Bachatt address, so the field starts pre-filled with it. */
const DEFAULT_EMAIL_DOMAIN = '@bachatt.app';

/** Mirrors the backend's username derivation so the form can preview it. */
const titleCase = (p: string) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();

function previewUsername(email: string, firstName: string, lastName: string): string {
  const nameParts = [firstName, lastName]
    .filter((s) => Boolean(s && s.trim()))
    .flatMap((s) => s.trim().split(/\s+/))
    .filter(Boolean)
    .map(titleCase);

  if (nameParts.length > 0) {
    return nameParts.join('_');
  }
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._\-+]+/).filter(Boolean).map(titleCase);
  return parts.length > 0 ? parts.join('_') : '';
}

/**
 * Guess a first/last name from the email's local part — the inverse of
 * `previewUsername`'s own fallback. Used to pre-fill the name fields as soon as
 * the email is typed, since our addresses already follow `first.last@…`: e.g.
 * `rishit.goel@bachatt.app` → `{ firstName: 'Rishit', lastName: 'Goel' }`. A
 * name of three-or-more tokens folds everything after the first into lastName
 * (space-joined), matching how the backend re-splits lastName on whitespace.
 */
function deriveNameFromEmail(email: string): { firstName: string; lastName: string } {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._\-+]+/).filter(Boolean).map(titleCase);
  if (parts.length === 0) {
    return { firstName: '', lastName: '' };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create an Apollo (Keycloak) login — super admin only.
 *
 * Creates the sign-in account and nothing else; roles are granted separately
 * (Hermes tiers via Admin Management, panel roles in the Keycloak console). Two
 * phases in one modal: the form, then a result panel. The result panel is not
 * dismissible-by-accident when a password is on screen, because that password is
 * shown exactly once and cannot be recovered afterwards (nothing persists it).
 */
export const CreateApolloUserModal: React.FC<CreateApolloUserModalProps> = ({
  onClose,
  onCreated,
  onError,
}) => {
  const [email, setEmail] = useState(DEFAULT_EMAIL_DOMAIN);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [result, setResult] = useState<CreateApolloUserResult | null>(null);

  // Once the admin edits a name by hand, stop overwriting it from the email —
  // otherwise correcting "Dsouza" to "D'Souza" would be undone by the next
  // keystroke in the email field.
  const nameEditedByHand = useRef(false);
  const emailInputRef = useRef<HTMLInputElement>(null);

  // The field is pre-seeded with "@bachatt.app", so drop the caret in front of it
  // rather than at the end — they type the local part, not the domain.
  useEffect(() => {
    emailInputRef.current?.focus();
    emailInputRef.current?.setSelectionRange(0, 0);
  }, []);

  // Mirror the email's local part into the name fields as it is typed. Our
  // addresses are already `first.last@…`, so this is right almost every time and
  // stays correctable.
  useEffect(() => {
    if (nameEditedByHand.current) {
      return;
    }
    const derived = deriveNameFromEmail(email);
    setFirstName(derived.firstName);
    setLastName(derived.lastName);
  }, [email]);

  const emailValid = EMAIL_RE.test(email.trim());
  const username = previewUsername(email, firstName, lastName);

  const createMutation = useMutation({
    mutationFn: () =>
      createApolloUser({
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
      }),
    onSuccess: (data) => {
      setResult(data);
      // A delivered password needs no follow-up, so close straight out. When it
      // wasn't delivered the modal stays open on the result panel — closing would
      // destroy the only copy of the password.
      if (data.slack.delivered) {
        onCreated(
          `Apollo login created for ${data.email}. The temporary password was sent to them on Slack.`,
        );
        onClose();
      }
    },
    onError: (e: any) => onError(e.message || 'Failed to create the Apollo login.'),
  });

  const submit = () => {
    if (emailValid && !createMutation.isPending && !result) {
      createMutation.mutate();
    }
  };

  const finish = () => {
    if (result) {
      onCreated(`Apollo login created for ${result.email}.`);
    }
    onClose();
  };

  // Dismissing by overlay/close-button is disabled while an undelivered password
  // is on screen — it exists nowhere else.
  const passwordOnScreen = !!result?.temporaryPassword;
  const requestClose = () => {
    if (!passwordOnScreen) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '560px' }}>
        <div className="modal-header" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="modal-title">
              {result ? 'Apollo login created' : 'Create Apollo login'}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.4 }}>
              {result
                ? 'The account exists in Keycloak and can sign in now.'
                : 'Creates a Keycloak user who can sign in to the admin panel. They get a random password on Slack and must change it at first login.'}
            </div>
          </div>
          {!passwordOnScreen && (
            <button type="button" className="modal-close-btn" onClick={onClose}>
              <Icons.X size={20} />
            </button>
          )}
        </div>

        <div className="modal-body">
          {/* ── Result panel ───────────────────────────────────────────────── */}
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
                  <span>The temporary password was sent to {result.email} on Slack.</span>
                </div>
              )}

              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                The account has no roles yet, so they can sign in but will see almost nothing. Grant
                Hermes admin tiers below on this page; other panel roles are managed in Keycloak.
              </div>
            </div>
          ) : (
            /* ── Form ─────────────────────────────────────────────────────── */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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
                <div style={{ fontSize: '11.5px', color: 'var(--text-light)', marginTop: '4px' }}>
                  The password is DM'd to this address on Slack, so it must match their Slack account.
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">First name</label>
                  <input
                    className="form-input"
                    value={firstName}
                    onChange={(e) => {
                      nameEditedByHand.current = true;
                      setFirstName(e.target.value);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Last name</label>
                  <input
                    className="form-input"
                    value={lastName}
                    onChange={(e) => {
                      nameEditedByHand.current = true;
                      setLastName(e.target.value);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                  />
                </div>
              </div>

              <div style={{ fontSize: '11.5px', color: 'var(--text-light)' }}>
                Filled in from the email — edit either field if the guess is wrong.
              </div>

              {username && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Username will be <strong>{username}</strong>
                  {' '}(a number is appended if that's taken).
                </div>
              )}

              <div style={{ fontSize: '11.5px', color: 'var(--text-light)', lineHeight: 1.5 }}>
                The account is created with no roles — they'll be able to sign in and nothing more.
                Assign Hermes admin tiers from this page afterwards; other panel roles are managed in
                Keycloak.
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
              <button type="button" className="btn btn-outline" onClick={onClose} disabled={createMutation.isPending}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!emailValid || createMutation.isPending}
                style={
                  !emailValid
                    ? { background: 'var(--bg-inset)', color: 'var(--text-light)', boxShadow: 'none' }
                    : undefined
                }
                onClick={submit}
              >
                {createMutation.isPending ? 'Creating…' : 'Create & send password'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CreateApolloUserModal;
