import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as Icons from 'lucide-react';

export interface SearchableSelectOption {
  value: string;
  label: string;
  groupName?: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  // ── Optional multi-select (checkbox column) ──────────────────────────────────
  // When both `selectedValues` and `onToggleValue` are provided, each option grows a checkbox on
  // its left for building a multi-selection alongside the single focused `value`. Clicking the
  // checkbox toggles membership and keeps the dropdown open; clicking the rest of the row still
  // picks that option as the single focused value (and closes), exactly as in single-select mode.
  selectedValues?: Set<string>;
  onToggleValue?: (value: string) => void;
  // "Select all" unions the currently-visible (search-filtered) values into the selection.
  onSelectAllFiltered?: (values: string[]) => void;
  onClearSelection?: () => void;
}

export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Select an option...',
  disabled = false,
  style,
  selectedValues,
  onToggleValue,
  onSelectAllFiltered,
  onClearSelection,
}) => {
  const multiSelect = !!(selectedValues && onToggleValue);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

  const selectedOption = useMemo(() => options.find((opt) => opt.value === value), [options, value]);

  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return options;
    // Stage-2 search: substring match — the query just has to appear anywhere in the label
    // (or its group), not at the start. Prefix narrowing is done upstream (see SecretIngestion).
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        (opt.groupName && opt.groupName.toLowerCase().includes(query))
    );
  }, [options, search]);

  // Keep the highlighted row scrolled into view as it moves.
  useEffect(() => {
    if (activeIndex >= 0 && optionRefs.current[activeIndex]) {
      optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  // Handle open state side effects
  useEffect(() => {
    if (isOpen) {
      // Small timeout to guarantee DOM is rendered before focusing
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 30);
      setActiveIndex(0);
      return () => clearTimeout(timer);
    } else {
      setSearch('');
    }
  }, [isOpen]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) => (filteredOptions.length === 0 ? -1 : (prev + 1) % filteredOptions.length));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) =>
          filteredOptions.length === 0 ? -1 : (prev - 1 + filteredOptions.length) % filteredOptions.length
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < filteredOptions.length) {
          onChange(filteredOptions[activeIndex].value);
          setIsOpen(false);
        }
        break;
      case 'Escape':
      case 'Tab':
        setIsOpen(false);
        break;
      default:
        break;
    }
  };

  const selectOption = (opt: SearchableSelectOption) => {
    onChange(opt.value);
    setIsOpen(false);
  };

  return (
    <div
      ref={containerRef}
      className={`searchable-select-container ${disabled ? 'disabled' : ''} ${isOpen ? 'open' : ''}`}
      style={style}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="searchable-select-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="trigger-value">
          {selectedOption ? (
            <>
              <span className="trigger-label">{selectedOption.label}</span>
              {selectedOption.groupName && (
                <span className="trigger-group-badge">{selectedOption.groupName}</span>
              )}
            </>
          ) : (
            <span className="trigger-placeholder">{placeholder}</span>
          )}
          {multiSelect && selectedValues!.size > 0 && (
            <span className="trigger-group-badge" style={{ background: 'var(--primary)', color: '#fff' }}>
              {selectedValues!.size} selected
            </span>
          )}
        </span>
        <Icons.ChevronDown size={16} className={`chevron-icon ${isOpen ? 'rotate' : ''}`} />
      </button>

      {isOpen && (
        <div className="searchable-select-dropdown">
          <div className="searchable-select-search-row">
            <Icons.Search size={14} className="search-icon" />
            <input
              ref={inputRef}
              type="text"
              className="searchable-select-search-input"
              placeholder="Search secret..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setActiveIndex(0);
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {search && (
              <button
                type="button"
                className="searchable-select-clear-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setSearch('');
                  inputRef.current?.focus();
                }}
              >
                <Icons.X size={12} />
              </button>
            )}
          </div>

          {multiSelect && (
            <div
              className="searchable-select-multi-toolbar"
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', borderBottom: '1px solid var(--border)', fontSize: 12 }}
            >
              <span style={{ color: 'var(--text-muted)' }}>{selectedValues!.size} selected</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAllFiltered?.(filteredOptions.map((o) => o.value));
                }}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0, fontSize: 12 }}
              >
                Select all{filteredOptions.length !== options.length ? ` (${filteredOptions.length})` : ''}
              </button>
              {selectedValues!.size > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearSelection?.();
                  }}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                >
                  Clear
                </button>
              )}
            </div>
          )}

          <div ref={listRef} className="searchable-select-options-list" role="listbox">
            {filteredOptions.length === 0 ? (
              <div className="searchable-select-no-results">No secrets matched.</div>
            ) : (
              filteredOptions.map((opt, index) => {
                const isSelected = opt.value === value;
                const isActive = index === activeIndex;
                const isChecked = multiSelect && selectedValues!.has(opt.value);

                return (
                  <div
                    key={opt.value}
                    ref={(el) => {
                      optionRefs.current[index] = el;
                    }}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    className={`searchable-select-option-item ${isSelected ? 'selected' : ''} ${
                      isActive ? 'active' : ''
                    }`}
                    onClick={() => selectOption(opt)}
                    onMouseEnter={() => setActiveIndex(index)}
                    style={{ cursor: 'pointer' }}
                  >
                    {multiSelect && (
                      <input
                        type="checkbox"
                        checked={isChecked}
                        aria-label={`Select ${opt.label} for bulk add`}
                        onChange={() => onToggleValue!(opt.value)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ flexShrink: 0, cursor: 'pointer', marginRight: 2 }}
                      />
                    )}
                    <span className="option-label">{opt.label}</span>
                    {opt.groupName && (
                      <span className="option-group-badge">{opt.groupName}</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
