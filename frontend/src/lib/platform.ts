/** True on macOS — used to show ⌘ instead of Ctrl in keyboard-shortcut hints. */
export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent ?? '');

/** Display label for the command-palette shortcut, platform-aware. */
export const commandPaletteShortcutLabel = (): string => (isMac() ? '⌘K' : 'Ctrl K');
