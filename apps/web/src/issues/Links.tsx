// The links of an issue: http(s) addresses, checked before they are sent.
import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../design/components/Button.tsx';
import { Input } from '../design/components/Input.tsx';
import { useT } from '../design/locale.tsx';
import type { SyncedIssueLink } from '../sync/collections.ts';

export function Links({
  links,
  readOnly,
  onAdd,
  onRemove,
}: {
  links: SyncedIssueLink[];
  readOnly: boolean;
  /** Rejects with the refusal (an address that is not http or https is refused before it is sent). */
  onAdd: (url: string, title: string) => Promise<void>;
  onRemove: (linkId: string) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [invalid, setInvalid] = useState(false);
  if (links.length === 0 && readOnly) return null;
  return (
    <section className="issue-section-block" aria-label={t('issue.links')}>
      <h3 className="issue-section-block__title">{t('issue.links')}</h3>
      <ul className="issue-section-block__list">
        {links.map((link) => (
          <li key={link.id}>
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="issue-link">
              {link.title || link.url}
            </a>
            {readOnly ? null : (
              <button
                type="button"
                className="chip__remove"
                aria-label={t('issue.link.remove', { url: link.title || link.url })}
                onClick={() => onRemove(link.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <form
          className="issue-section-block__add"
          onSubmit={(event) => {
            event.preventDefault();
            setInvalid(false);
            onAdd(url, title).then(
              () => {
                setUrl('');
                setTitle('');
              },
              () => setInvalid(true),
            );
          }}
        >
          <Input
            aria-label={t('issue.link.url')}
            placeholder={t('issue.link.url')}
            value={url}
            aria-invalid={invalid || undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Input
            aria-label={t('issue.link.title')}
            placeholder={t('issue.link.title')}
            value={title}
            maxLength={255}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" size="sm">
            {t('issue.link.add')}
          </Button>
          {invalid ? (
            <p className="issues__error" role="alert">
              {t('issue.link.invalid')}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
