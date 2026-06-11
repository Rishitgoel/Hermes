import '@testing-library/jest-dom';
import { vi } from 'vitest';
import React from 'react';

// Mock all lucide-react exports statically as a plain object to prevent ES Module import validation issues.
vi.mock('lucide-react', () => {
  const DummyIcon = (props: any) => {
    const { size, ...cleanProps } = props;
    return React.createElement('span', {
      ...cleanProps,
      'data-testid': 'mock-icon',
    });
  };

  return {
    Loader2: DummyIcon,
    ShieldCheck: DummyIcon,
    FileClock: DummyIcon,
    CheckSquare: DummyIcon,
    Info: DummyIcon,
    Clock: DummyIcon,
    CheckCircle2: DummyIcon,
    ExternalLink: DummyIcon,
    Shield: DummyIcon,
    Users: DummyIcon,
    History: DummyIcon,
    AlertCircle: DummyIcon,
    CheckCircle: DummyIcon,
    Key: DummyIcon,
    LogOut: DummyIcon,
    ChevronRight: DummyIcon,
    Search: DummyIcon,
    UserPlus: DummyIcon,
    Sliders: DummyIcon,
    Plus: DummyIcon,
    RefreshCw: DummyIcon,
    Trash2: DummyIcon,
    Edit: DummyIcon,
  };
});
