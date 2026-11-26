import { MAX_COMMENT_LENGTH } from '@torch/shared/mutations/comment';
import { useEffect, useRef, useState } from 'react';
import { Button, isMacPlatform, Textarea, useT } from '../design/index.ts';

// A draft lives in this tab only: it is gone when the tab closes, and never reaches the device store or the server.
const draftKey = (scope: string) => `ui-comment-draft-${scope}`;

function readDraft(scope: string): string {
  try {
    return sessionStorage.getItem(draftKey(scope)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(scope: string, text: string) {
  try {
    if (text === '') sessionStorage.removeItem(draftKey(scope));
    else sessionStorage.setItem(draftKey(scope), text);
  } catch {
    // Private mode or a full store: the draft just does not survive a re-render of the screen.
  }
}

/**
 * The box a comment is written in. Cmd or Ctrl+Enter sends. The draft is kept per issue (and per thread, for a reply) in
 * `sessionStorage`; sending clears it at once, and a refused send puts the text back. `disabled` says why through `note`.
 */
export function Composer({
  scope,
  label,
  placeholder,
  submitLabel,
  disabled = false,
  note,
  compact = false,
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  /** What the draft belongs to: `<issueId>` or `<issueId>:<parentId>`. */
  scope: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  disabled?: boolean;
  note?: string;
  /** Collapsed to one line until it is focused (the issue peek). */
  compact?: boolean;
  autoFocus?: boolean;
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => readDraft(scope));
  const [open, setOpen] = useState(!compact || draft !== '');
  const latest = useRef(draft);
  latest.current = draft;

  // The same composer shown for another issue or thread starts from that one's draft.
  const shown = useRef(scope);
  useEffect(() => {
    if (shown.current === scope) return;
    shown.current = scope;
    setDraft(readDraft(scope));
  }, [scope]);

  const change = (text: string) => {
    setDraft(text);
    writeDraft(scope, text);
  };

  const send = () => {
    const text = draft.trim();
    if (disabled || text === '' || text.length > MAX_COMMENT_LENGTH) return;
    // The text leaves the box at once; a refusal gives it back unless the person has started something new.
    change('');
    if (compact) setOpen(false);
    onSubmit(text).catch(() => {
      if (latest.current === '') change(text);
      if (compact) setOpen(true);
    });
  };

  if (disabled) {
    return (
      <p className="composer__note" data-testid="composer-note">
        {note}
      </p>
    );
  }

  if (compact && !open) {
    return (
      <button type="button" className="composer__collapsed" onClick={() => setOpen(true)}>
        {placeholder}
      </button>
    );
  }

  const keys = isMacPlatform() ? '⌘↵' : 'Ctrl+↵';
  return (
    <div className="composer">
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        rows={compact ? 2 : 3}
        maxLength={MAX_COMMENT_LENGTH}
        autoFocus={autoFocus || (compact && open)}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="composer__bar">
        <span className="composer__hint" aria-hidden="true">
          {keys}
        </span>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
        <Button size="sm" variant="primary" disabled={draft.trim() === ''} onClick={send}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
