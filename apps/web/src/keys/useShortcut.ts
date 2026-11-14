import { useEffect, useRef } from 'react';
import { registerShortcut, type Shortcut } from './keymap.ts';

/** Registers a shortcut while the component is mounted (and `enabled`); the handler may change on every render. */
export function useShortcut(
  shortcut: Shortcut,
  handler: () => void,
  options: { enabled?: boolean } = {},
): void {
  const { id, keys, labelKey, scope } = shortcut;
  const enabled = options.enabled ?? true;
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    return registerShortcut({ id, keys, labelKey, scope }, () => handlerRef.current());
  }, [id, keys, labelKey, scope, enabled]);
}
