import { REACTION_EMOJI } from '@torch/shared/mutations/comment';
import { SmilePlus } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../design/cx.ts';
import { IconButton, Popover, Tooltip, useT } from '../design/index.ts';
import type { SyncedMember } from '../sync/collections.ts';

/**
 * The reactions of one comment: a chip per emoji with its count (the people on hover, by name from the members shape), and
 * a picker with the fixed set. A chip of an emoji this person gave is pressed; pressing it takes the reaction back.
 */
export function ReactionBar({
  reactions,
  memberId,
  members,
  readOnly,
  onToggle,
}: {
  reactions: Record<string, string[]>;
  memberId: string;
  members: ReadonlyMap<string, SyncedMember>;
  readOnly: boolean;
  onToggle: (emoji: string, on: boolean) => void;
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  const given = REACTION_EMOJI.filter((emoji) => (reactions[emoji]?.length ?? 0) > 0);

  const names = (people: readonly string[]) =>
    people
      .map((id) =>
        id === memberId ? t('comments.you') : (members.get(id)?.name ?? t('comments.formerMember')),
      )
      .join(', ');

  return (
    <div className="reactions">
      {given.map((emoji) => {
        const people = reactions[emoji] ?? [];
        const mine = people.includes(memberId);
        return (
          <Tooltip key={emoji} content={t('comments.reactedBy', { names: names(people) })}>
            <button
              type="button"
              className={cx('reactions__chip', mine && 'reactions__chip--mine')}
              aria-pressed={mine}
              aria-label={`${t('comments.react', { emoji })} (${people.length})`}
              disabled={readOnly}
              onClick={() => onToggle(emoji, !mine)}
            >
              <span aria-hidden="true">{emoji}</span>
              <span className="reactions__count">{people.length}</span>
            </button>
          </Tooltip>
        );
      })}
      {readOnly ? null : (
        <Popover
          open={picking}
          onOpenChange={setPicking}
          label={t('comments.addReaction')}
          trigger={
            <IconButton
              size="sm"
              label={t('comments.addReaction')}
              icon={<SmilePlus size={14} aria-hidden="true" />}
            />
          }
        >
          <div className="reactions__picker">
            {REACTION_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="reactions__pick"
                aria-label={t('comments.react', { emoji })}
                onClick={() => {
                  setPicking(false);
                  onToggle(emoji, !(reactions[emoji] ?? []).includes(memberId));
                }}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
