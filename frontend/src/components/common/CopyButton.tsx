import React, { useState } from 'react';
import * as Icons from 'lucide-react';

export interface CopyButtonProps {
  value: string;
  title?: string;
  size?: number;
  style?: React.CSSProperties;
  className?: string;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  value,
  title = 'Copy',
  size = 12,
  style,
  className,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied!' : title}
      className={className}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: copied ? '#16a34a' : 'var(--text-muted)',
        padding: '2px 4px',
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        flexShrink: 0,
        transition: 'all 0.15s ease',
        ...style,
      }}
    >
      {copied ? <Icons.Check size={size} /> : <Icons.Copy size={size} />}
    </button>
  );
};

export default CopyButton;
