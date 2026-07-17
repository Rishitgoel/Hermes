import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import Modal from './Modal';
import { detectType, prettyValue, TYPE_META, type ValueType } from '../../lib/valueFormat';

/**
 * A proper, readable viewer for a single value (JSON pretty-printed, everything else verbatim),
 * shown in a large modal so a big value — the thing that used to overflow its table row / tree
 * row — can be read in full. Supports a before → after view (e.g. a Secret Ingestion UPDATE or a
 * ZooKeeper SET) by passing more than one section.
 */

export interface ViewerSection {
  /** e.g. "Before" / "After" / "Value". Omit for a single unlabelled value. */
  label?: string;
  value: string | null;
  /** Colours the section header; 'old' = red/struck, 'new' = green, 'neutral' = plain. */
  tone?: 'old' | 'new' | 'neutral';
}

const TONE_COLOR: Record<NonNullable<ViewerSection['tone']>, string> = {
  old: '#991b1b',
  new: '#166534',
  neutral: 'var(--text-main)',
};

/** Inline type badge (json/array/num/bool/str) — same palette as the ZooKeeper TypeChip. */
const TypeBadge: React.FC<{ type: ValueType }> = ({ type }) => {
  if (type === 'empty') return null;
  const m = TYPE_META[type];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        color: m.color,
        border: `1px solid ${m.color}`,
        borderRadius: 4,
        padding: '0 4px',
        lineHeight: '15px',
        flexShrink: 0,
      }}
    >
      {m.label}
    </span>
  );
};

const SectionBlock: React.FC<{ section: ViewerSection }> = ({ section }) => {
  const [copied, setCopied] = useState(false);
  const pretty = prettyValue(section.value);
  const type = detectType(section.value);
  const isEmpty = section.value == null || section.value === '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(section.value ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {section.label && (
          <span style={{ fontSize: 12, fontWeight: 700, color: TONE_COLOR[section.tone ?? 'neutral'] }}>
            {section.label}
          </span>
        )}
        <TypeBadge type={type} />
        <button
          type="button"
          onClick={copy}
          disabled={isEmpty}
          title="Copy value"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: 'none',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 11,
            cursor: isEmpty ? 'default' : 'pointer',
            color: 'var(--text-muted)',
            opacity: isEmpty ? 0.5 : 1,
          }}
        >
          {copied ? <Icons.Check size={12} /> : <Icons.Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {isEmpty ? (
        <em style={{ color: 'var(--text-light)', fontSize: 13 }}>(empty)</em>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: '10px 12px',
            background: 'var(--bg-inset, var(--bg-card))',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontFamily: 'monospace',
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--text-main)',
            // The whole point: contain any value. Wrap long lines, scroll vertically past a
            // cap, and never push the modal wider than itself.
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowX: 'auto',
            overflowY: 'auto',
            maxHeight: '50vh',
          }}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
};

export const JsonValueViewer: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  sections: ViewerSection[];
}> = ({ isOpen, onClose, title, sections }) => (
  <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {sections.map((s, i) => (
        <SectionBlock key={s.label ?? i} section={s} />
      ))}
    </div>
  </Modal>
);

/**
 * A small "expand" icon button that opens the JSON viewer for its value(s). Drop it next to any
 * inline value preview so a value too big to read in a row can be opened in full.
 */
export const JsonViewerButton: React.FC<{
  title: React.ReactNode;
  sections: ViewerSection[];
  /** icon size in px */
  size?: number;
}> = ({ title, sections, size = 13 }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="View full value"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-muted)',
          padding: 0,
          lineHeight: 1,
          display: 'inline-flex',
          flexShrink: 0,
        }}
      >
        <Icons.Maximize2 size={size} />
      </button>
      <JsonValueViewer isOpen={open} onClose={() => setOpen(false)} title={title} sections={sections} />
    </>
  );
};

export default JsonValueViewer;
