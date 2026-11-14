/**
 * The shortcut registry: one module-level map and one `keydown` listener on the document (added with the first
 * registration, removed with the last). Screens register through `useShortcut`; the `?` help reads `listShortcuts`.
 *
 * Keys are written `mod+k` (a chord; `mod` accepts Ctrl or Cmd), `?` (one key) or `g i` (a sequence: the second
 * key must follow within one second). Plain keys are ignored while focus is in a text field, so typing never fires
 * a shortcut; chords that include `mod` still work there.
 */

export type Shortcut = {
  id: string;
  keys: string;
  /** i18n key of the label the help shows. */
  labelKey: string;
  scope?: 'global' | (string & {});
};

type Step = {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};
type Entry = {
  shortcut: Shortcut;
  handler: (event: KeyboardEvent) => void;
  steps: Step[];
  order: number;
};

const SEQUENCE_TIMEOUT_MS = 1000;
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  space: ' ',
  plus: '+',
};

const entries = new Map<string, Entry>();
let nextOrder = 0;
let listening = false;
let pending: { steps: Step[]; timer: ReturnType<typeof setTimeout> } | undefined;

function parseStep(text: string): Step {
  const step: Step = { key: '', mod: false, ctrl: false, meta: false, alt: false, shift: false };
  const parts = text
    .split('+')
    .filter((part, index, all) => part !== '' || index === all.length - 1);
  // "mod++" and a lone "+" mean the plus key itself.
  const keyPart = text.endsWith('++') || text === '+' ? '+' : (parts.pop() ?? '');
  for (const part of parts) {
    const name = part.toLowerCase();
    if (
      name === 'mod' ||
      name === 'ctrl' ||
      name === 'meta' ||
      name === 'alt' ||
      name === 'shift'
    ) {
      step[name] = true;
    }
  }
  const lower = keyPart.toLowerCase();
  step.key = KEY_ALIASES[lower] ?? lower;
  return step;
}

function parseKeys(keys: string): Step[] {
  return keys.trim().split(/\s+/).map(parseStep);
}

function matches(step: Step, event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== step.key) return false;
  const wantsCtrl = step.mod || step.ctrl;
  const wantsMeta = step.mod || step.meta;
  // `mod` is satisfied by either Ctrl or Cmd; an explicit ctrl or meta needs exactly that key.
  if (step.mod) {
    if (!(event.ctrlKey || event.metaKey)) return false;
  } else {
    if (event.ctrlKey !== wantsCtrl) return false;
    if (event.metaKey !== wantsMeta) return false;
  }
  if (event.altKey !== step.alt) return false;
  // Shift is part of the character for punctuation (`?` is shift+/), so only letters and named keys check it.
  const isLetterOrNamed = event.key.length > 1 || /^[a-z]$/i.test(event.key);
  if (isLetterOrNamed && event.shiftKey !== step.shift) return false;
  return true;
}

function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  const editable = target.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable') !== 'false';
}

function includesMod(entry: Entry, depth: number): boolean {
  const step = entry.steps[depth];
  return Boolean(step?.mod || step?.ctrl || step?.meta);
}

function clearPending() {
  if (pending) clearTimeout(pending.timer);
  pending = undefined;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  if (
    event.key === 'Shift' ||
    event.key === 'Control' ||
    event.key === 'Meta' ||
    event.key === 'Alt'
  )
    return;
  const typing = inTextField(event.target);

  const depth = pending?.steps.length ?? 0;
  const candidates = [...entries.values()].filter((entry) => {
    if (typing && !includesMod(entry, depth)) return false;
    if (entry.steps.length <= depth) return false;
    // The earlier steps of a sequence must be the ones already typed.
    for (let i = 0; i < depth; i++) {
      const typed = pending?.steps[i];
      const wanted = entry.steps[i];
      if (!typed || !wanted || typed.key !== wanted.key) return false;
    }
    const step = entry.steps[depth];
    return step !== undefined && matches(step, event);
  });

  if (candidates.length === 0) {
    // A sequence in progress that this key does not continue: start over with this key as a first key.
    if (depth > 0) {
      clearPending();
      onKeyDown(event);
    }
    return;
  }

  const complete = candidates.filter((entry) => entry.steps.length === depth + 1);
  const longer = candidates.filter((entry) => entry.steps.length > depth + 1);
  const finished = complete[0];
  if (finished) {
    clearPending();
    event.preventDefault();
    finished.handler(event);
    return;
  }
  if (longer.length > 0) {
    const step = candidates[0]?.steps[depth];
    clearPending();
    if (step) {
      pending = {
        steps: [...(pending?.steps ?? []), step],
        timer: setTimeout(clearPending, SEQUENCE_TIMEOUT_MS),
      };
    }
  }
}

/**
 * Registers a shortcut and returns the function that removes it. A second registration with the same `id`
 * replaces the first (and the first one's remover then does nothing).
 */
export function registerShortcut(
  shortcut: Shortcut,
  handler: (event: KeyboardEvent) => void,
): () => void {
  const previous = entries.get(shortcut.id);
  const entry: Entry = {
    shortcut,
    handler,
    steps: parseKeys(shortcut.keys),
    order: previous?.order ?? nextOrder++,
  };
  entries.set(shortcut.id, entry);
  if (!listening) {
    document.addEventListener('keydown', onKeyDown);
    listening = true;
  }
  return () => {
    if (entries.get(shortcut.id) !== entry) return;
    entries.delete(shortcut.id);
    if (entries.size === 0 && listening) {
      document.removeEventListener('keydown', onKeyDown);
      listening = false;
      clearPending();
    }
  };
}

/** Every registered shortcut: `global` first, then the other scopes by name, each in registration order. */
export function listShortcuts(): Shortcut[] {
  const scopeOf = (entry: Entry) => entry.shortcut.scope ?? 'global';
  return [...entries.values()]
    .sort((a, b) => {
      const scopeA = scopeOf(a);
      const scopeB = scopeOf(b);
      if (scopeA !== scopeB) {
        if (scopeA === 'global') return -1;
        if (scopeB === 'global') return 1;
        return scopeA < scopeB ? -1 : 1;
      }
      return a.order - b.order;
    })
    .map((entry) => entry.shortcut);
}
