// The keyboard of an issue list: one registration per key, through the shortcut registry, so `?` lists them and a plain
// key never fires while a text field has focus.
import { useShortcut } from '../keys/useShortcut.ts';

export type PickerKind = 'state' | 'priority' | 'assignee' | 'labels' | 'due' | 'estimate';

export type ListActions = {
  next: () => void;
  prev: () => void;
  select: () => void;
  clear: () => void;
  rename: () => void;
  picker: (kind: PickerKind) => void;
  /** Space: preview the current issue in the side panel. */
  peek?: () => void;
};

/** `enabled` is false while something else owns the keys (a picker or a dialog is open). */
export function useListKeys(actions: ListActions, enabled = true): void {
  const on = { enabled };
  useShortcut(
    { id: 'issues.next', keys: 'j', labelKey: 'shortcuts.issues.next' },
    actions.next,
    on,
  );
  useShortcut(
    { id: 'issues.prev', keys: 'k', labelKey: 'shortcuts.issues.prev' },
    actions.prev,
    on,
  );
  useShortcut(
    { id: 'issues.select', keys: 'x', labelKey: 'shortcuts.issues.select' },
    actions.select,
    on,
  );
  useShortcut(
    { id: 'issues.clear', keys: 'escape', labelKey: 'shortcuts.issues.clear' },
    actions.clear,
    on,
  );
  useShortcut(
    { id: 'issues.rename', keys: 'f2', labelKey: 'shortcuts.issues.rename' },
    actions.rename,
    on,
  );
  useShortcut(
    { id: 'issues.peek', keys: 'space', labelKey: 'shortcuts.issues.peek' },
    () => actions.peek?.(),
    on,
  );
  useShortcut(
    { id: 'issues.state', keys: 's', labelKey: 'shortcuts.issues.state' },
    () => actions.picker('state'),
    on,
  );
  useShortcut(
    { id: 'issues.priority', keys: 'p', labelKey: 'shortcuts.issues.priority' },
    () => actions.picker('priority'),
    on,
  );
  useShortcut(
    { id: 'issues.assignee', keys: 'a', labelKey: 'shortcuts.issues.assignee' },
    () => actions.picker('assignee'),
    on,
  );
  useShortcut(
    { id: 'issues.labels', keys: 'l', labelKey: 'shortcuts.issues.labels' },
    () => actions.picker('labels'),
    on,
  );
  useShortcut(
    { id: 'issues.due', keys: 'd', labelKey: 'shortcuts.issues.due' },
    () => actions.picker('due'),
    on,
  );
}
