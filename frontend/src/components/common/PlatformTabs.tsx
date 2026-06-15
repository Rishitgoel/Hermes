import React from 'react';
import * as Icons from 'lucide-react';
import { PLATFORMS, platformDisplayName } from '../../lib/platforms';

interface PlatformTabsProps {
  /** Platform keys to show as tabs (registry order from GET /api/platforms). */
  platforms: string[];
  active: string | null;
  onChange: (platform: string) => void;
}

/**
 * Scrollable underline tab bar for switching the active platform view. Each tab
 * carries the platform's own brand icon (from lib/platforms PLATFORMS meta). The
 * row scrolls horizontally when there are more platforms than fit, so it never
 * wraps into a cluttered block of pills.
 */
export const PlatformTabs: React.FC<PlatformTabsProps> = ({ platforms, active, onChange }) => {
  return (
    <div className="platform-tabs" role="tablist" aria-label="Platform">
      {platforms.map((p) => {
        const meta = PLATFORMS.find((m) => m.id === p);
        const Icon = (meta && (Icons as any)[meta.iconName]) || Icons.Box;
        const isActive = p === active;
        return (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`platform-tab${isActive ? ' active' : ''}`}
            onClick={() => onChange(p)}
          >
            <Icon size={15} style={{ color: meta?.color ?? 'var(--primary)' }} />
            {platformDisplayName(p)}
          </button>
        );
      })}
    </div>
  );
};

export default PlatformTabs;
