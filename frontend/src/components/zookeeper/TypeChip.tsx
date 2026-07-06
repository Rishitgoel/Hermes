import React from 'react';
import { TYPE_META, type ValueType } from './zkFormat';

/** Small colored chip labelling a value's inferred type (json/array/num/bool). */
export const TypeChip: React.FC<{ type: ValueType }> = ({ type }) => {
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

export default TypeChip;
