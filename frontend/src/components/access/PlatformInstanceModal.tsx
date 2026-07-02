import React from 'react';
import Modal from '../common/Modal';
import type { LivePlatform } from '../../services/api/platforms';
import { Server } from 'lucide-react';

interface PlatformInstanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Family display name, e.g. "Redash". */
  platformName: string;
  /** The live instances sharing this family (e.g. redash + redash-qa). */
  instances: LivePlatform[];
  onSelect: (key: string) => void;
}

/**
 * Shown when a platform card represents more than one registered instance
 * (e.g. Redash Prod + QA). Lets the user pick which instance's groups to browse.
 * Single-instance platforms never trigger this — Groups.tsx routes straight
 * through instead of opening it.
 */
export const PlatformInstanceModal: React.FC<PlatformInstanceModalProps> = ({
  isOpen,
  onClose,
  platformName,
  instances,
  onSelect,
}) => {
  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Choose a ${platformName} instance`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {instances.map((instance) => (
          <button
            key={instance.key}
            type="button"
            className="btn btn-outline"
            style={{ justifyContent: 'flex-start', gap: '10px', padding: '14px 16px' }}
            onClick={() => {
              onSelect(instance.key);
              onClose();
            }}
          >
            <Server size={16} style={{ color: 'var(--primary)' }} />
            <span style={{ fontWeight: 700 }}>{instance.label ?? instance.displayName}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
};

export default PlatformInstanceModal;
