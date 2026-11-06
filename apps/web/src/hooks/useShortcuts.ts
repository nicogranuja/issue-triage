import { useEffect, useRef } from 'react';

/**
 * Whether a key press is someone typing: into a text field, a select, or editable content.
 * Shortcuts never fire then, so typing "a" in a search box never accepts a suggestion.
 * Checkboxes and radio buttons are not text, but a reviewer who just ticked one should not
 * trigger an action by accident either, so they count too.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

/** A shortcut: the key (as `KeyboardEvent.key`) and what it does. */
export interface Shortcut {
  key: string;
  /** Also fire with Cmd (macOS) or Ctrl held, as in Cmd+Z. Other modifiers never match. */
  withMod?: boolean;
  /** Fire again while the key is held. Only for movement: holding "a" must not accept ten. */
  repeat?: boolean;
  /** Extra condition on the event, such as "not while a button has focus". */
  when?: (event: KeyboardEvent) => boolean;
  run: (event: KeyboardEvent) => void;
}

/**
 * Listens for single-key shortcuts on the window. The latest `shortcuts` are read on every key
 * press, so callers can pass a fresh list each render without re-subscribing.
 */
export function useShortcuts(shortcuts: readonly Shortcut[]): void {
  const latest = useRef(shortcuts);
  useEffect(() => {
    latest.current = shortcuts;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isTypingTarget(event.target)) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      const shortcut = latest.current.find(
        (candidate) =>
          candidate.key === event.key &&
          !event.altKey &&
          (candidate.withMod ? true : !mod) &&
          (candidate.repeat === true || !event.repeat) &&
          (candidate.when?.(event) ?? true),
      );
      if (shortcut) {
        event.preventDefault();
        shortcut.run(event);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
