import React, { useMemo, useState } from 'react';
import Modal from '../common/Modal';
import apiClient from '../../services/apiClient';
import type { GroupLevelOption } from './AccessRequestModal';

interface ChangeLevelModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  groupName: string;
  /** All active levels of this group (with rank). */
  levels: GroupLevelOption[];
  /** The level the user currently holds. */
  currentLevelId: string;
  currentLevelName?: string | null;
  onSuccess: () => void;
}

const rankOf = (lvl?: GroupLevelOption) => lvl?.rank ?? 0;

export const ChangeLevelModal: React.FC<ChangeLevelModalProps> = ({
  isOpen,
  onClose,
  groupId,
  groupName,
  levels,
  currentLevelId,
  currentLevelName,
  onSuccess,
}) => {
  const [justification, setJustification] = useState('');
  const [duration, setDuration] = useState('PERMANENT');
  const [levelId, setLevelId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // After a successful submit we show a confirmation that reflects what happened
  // (applied immediately vs queued for approval) rather than closing silently.
  const [result, setResult] = useState<{ instant: boolean } | null>(null);

  const currentLevel = useMemo(
    () => levels.find((l) => l.id === currentLevelId),
    [levels, currentLevelId],
  );
  // Choices exclude the level the user already holds.
  const choices = useMemo(
    () => levels.filter((l) => l.id !== currentLevelId),
    [levels, currentLevelId],
  );

  const selected = choices.find((l) => l.id === levelId);
  // A move to a strictly lower rank is a demotion (applies immediately). The server
  // is authoritative; this only drives the hint shown to the user.
  const isDemotion = !!selected && rankOf(selected) < rankOf(currentLevel);

  const resetForm = () => {
    setJustification('');
    setDuration('PERMANENT');
    setLevelId('');
    setErrorMsg(null);
    setResult(null);
  };

  const handleClose = () => {
    if (isSubmitting) return;
    resetForm();
    onClose();
  };

  const handleDone = () => {
    onSuccess();
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!levelId) {
      setErrorMsg('Please choose the level you want to move to.');
      return;
    }
    if (justification.trim().length < 10) {
      setErrorMsg('Please write a justification of at least 10 characters.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await apiClient.post('/api/access-requests/change-level', {
        groupId,
        levelId,
        justification,
        duration,
      });
      setResult({ instant: res.data?.kind === 'instant' });
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to change level');
    } finally {
      setIsSubmitting(false);
    }
  };

  const footerActions = result ? (
    <button type="button" className="btn btn-primary" onClick={handleDone}>
      Done
    </button>
  ) : (
    <>
      <button type="button" className="btn btn-outline" onClick={handleClose} disabled={isSubmitting}>
        Cancel
      </button>
      <button type="submit" form="change-level-form" className="btn btn-primary" disabled={isSubmitting}>
        {isSubmitting ? 'Submitting...' : isDemotion ? 'Apply Change' : 'Request Change'}
      </button>
    </>
  );

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={`Change Level — ${groupName}`} footer={footerActions}>
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div
            style={{
              backgroundColor: 'var(--status-approved-bg)',
              color: 'var(--status-approved-text)',
              padding: '14px',
              borderRadius: 'var(--radius-sm)',
              fontSize: '14px',
              fontWeight: 600,
            }}
          >
            {result.instant
              ? `Your level for ${groupName} was changed to "${selected?.name}" and applied immediately.`
              : `Your request to move to "${selected?.name}" was submitted. You'll keep your current level (${currentLevelName ?? 'current'}) until an admin approves it.`}
          </div>
        </div>
      ) : (
        <form id="change-level-form" onSubmit={handleSubmit}>
          {errorMsg && (
            <div
              style={{
                backgroundColor: 'var(--status-rejected-bg)',
                color: 'var(--status-rejected-text)',
                padding: '12px',
                borderRadius: 'var(--radius-sm)',
                fontSize: '13px',
                fontWeight: 600,
                marginBottom: '16px',
              }}
            >
              {errorMsg}
            </div>
          )}

          <div
            style={{
              fontSize: '13px',
              color: 'var(--text-muted)',
              marginBottom: '14px',
            }}
          >
            You currently hold{' '}
            <strong style={{ color: 'var(--text-main)' }}>{currentLevelName ?? currentLevel?.name ?? 'a level'}</strong>{' '}
            in this group. Choose a different level below. You can only hold one level at a time, so this replaces your current one.
          </div>

          <div className="form-group">
            <label className="form-label">Move to level</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {choices.map((lvl) => {
                const isSel = levelId === lvl.id;
                const demote = rankOf(lvl) < rankOf(currentLevel);
                return (
                  <label
                    key={lvl.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                      padding: '10px 12px',
                      border: `1px solid ${isSel ? 'var(--primary)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: isSel ? 'var(--primary-subtle, rgba(0,0,0,0.03))' : 'transparent',
                      cursor: isSubmitting ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="target-level"
                      value={lvl.id}
                      checked={isSel}
                      onChange={() => setLevelId(lvl.id)}
                      disabled={isSubmitting}
                      style={{ marginTop: '3px' }}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>
                        {lvl.name}
                        {lvl.permission && (
                          <span
                            style={{
                              marginLeft: '8px',
                              fontSize: '11px',
                              fontWeight: 600,
                              color: 'var(--text-muted)',
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '1px 6px',
                            }}
                          >
                            {lvl.permission}
                          </span>
                        )}
                        <span
                          style={{
                            marginLeft: '8px',
                            fontSize: '10px',
                            fontWeight: 700,
                            letterSpacing: '0.03em',
                            padding: '1px 7px',
                            borderRadius: 999,
                            background: demote ? 'var(--status-approved-bg)' : 'var(--status-pending-bg)',
                            color: demote ? 'var(--status-approved-text)' : 'var(--status-pending-text)',
                          }}
                        >
                          {demote ? 'APPLIES IMMEDIATELY' : 'NEEDS APPROVAL'}
                        </span>
                      </span>
                      {lvl.description && (
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{lvl.description}</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-light)' }}>
              Moving to a lower level applies immediately. Moving to a higher (or equal) level needs admin approval — you keep your current level until then.
            </span>
          </div>

          <div className="form-group">
            <label className="form-label">Justification / Reason</label>
            <textarea
              className="form-textarea"
              placeholder="Explain why you need a different level for this group..."
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              disabled={isSubmitting}
              required
            />
            <span style={{ fontSize: '11px', color: 'var(--text-light)' }}>
              Minimum 10 characters. Keep it brief and clear.
            </span>
          </div>

          {/* Duration only applies to a promotion (a new grant going through approval).
              A demotion keeps the current grant's duration server-side, so we don't
              offer (or send) a duration for it — picking one here would be ignored. */}
          {isDemotion ? (
            <div
              style={{
                fontSize: '12px',
                background: 'var(--status-approved-bg)',
                color: 'var(--status-approved-text)',
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Your current access duration is kept — a demotion only changes your level, not when your access expires.
            </div>
          ) : (
            <div className="form-group">
              <label className="form-label">Access Duration</label>
              <select
                className="form-select"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                disabled={isSubmitting}
              >
                <option value="PERMANENT">Permanent Access</option>
                <option value="ONE_DAY">1 Day (Temp Access)</option>
                <option value="ONE_WEEK">1 Week</option>
                <option value="ONE_MONTH">1 Month</option>
                <option value="THREE_MONTHS">3 Months</option>
              </select>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
};

export default ChangeLevelModal;
