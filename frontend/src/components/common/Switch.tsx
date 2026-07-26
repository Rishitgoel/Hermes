import React from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Required — the switch has no visible text of its own. */
  'aria-label': string;
  title?: string;
}

/**
 * The one toggle switch in Hermes. All visuals come from the `.switch` rules in
 * global.css, so it themes correctly and gets a keyboard focus ring — the
 * hand-inlined switch this replaces had neither (it hardcoded #ccc for the off
 * state, which vanished in dark mode, and was invisible when tabbed to).
 */
export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  disabled,
  title,
  'aria-label': ariaLabel,
}) => (
  <label className="switch" title={title}>
    <input
      type="checkbox"
      role="switch"
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span className="switch-slider" />
  </label>
);

export default Switch;
