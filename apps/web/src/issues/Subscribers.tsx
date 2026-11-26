// Who follows an issue. Anyone can add a member; removing is for oneself (the server refuses the rest).
import { X } from 'lucide-react';
import { Avatar } from '../design/components/Avatar.tsx';
import { useT } from '../design/locale.tsx';
import type { SyncedMember } from '../sync/collections.ts';

export function Subscribers({
  subscriberIds,
  members,
  membersById,
  meId,
  readOnly,
  onAdd,
  onRemoveSelf,
}: {
  subscriberIds: readonly string[];
  /** Active members: whom to offer. */
  members: readonly SyncedMember[];
  membersById: ReadonlyMap<string, SyncedMember>;
  meId: string;
  readOnly: boolean;
  onAdd: (memberId: string) => void;
  onRemoveSelf: () => void;
}) {
  const t = useT();
  const following = new Set(subscriberIds);
  const offered = members.filter((member) => !following.has(member.id));
  if (subscriberIds.length === 0 && (readOnly || offered.length === 0)) return null;
  return (
    <section className="issue-section-block" aria-label={t('issue.subscribers')}>
      <h3 className="issue-section-block__title">{t('issue.subscribers')}</h3>
      <ul className="issue-section-block__list issue-section-block__list--row">
        {subscriberIds.map((id) => {
          const name = membersById.get(id)?.name ?? t('issue.activity.someone');
          return (
            <li key={id} data-testid="subscriber">
              <Avatar name={name} size="sm" />
              {name}
              {id === meId && !readOnly ? (
                <button
                  type="button"
                  className="chip__remove"
                  aria-label={t('issue.subscribers.remove', { name })}
                  onClick={onRemoveSelf}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {readOnly || offered.length === 0 ? null : (
        <select
          className="field"
          aria-label={t('issue.subscribers.add')}
          value=""
          onChange={(event) => event.target.value && onAdd(event.target.value)}
        >
          <option value="">{t('issue.subscribers.add')}</option>
          {offered.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      )}
    </section>
  );
}
