// The history of an issue, newest last, one sentence per row. The text of a description is never in it.
import { useMemo } from 'react';
import { useLocale, useT } from '../design/locale.tsx';
import type { SyncedActivity } from '../sync/collections.ts';
import type { TeamData } from './data.ts';
import { describeActivity } from './model/detail.ts';

export function IssueActivity({
  activity,
  data,
}: {
  activity: SyncedActivity[];
  data: Pick<TeamData, 'statesById' | 'membersById' | 'labelsById'>;
}) {
  const t = useT();
  const locale = useLocale();
  const lines = useMemo(
    () =>
      activity.map((row) => {
        const { key, vars } = describeActivity(
          row,
          {
            member: (id) => data.membersById.get(id)?.name,
            state: (id) => data.statesById.get(id)?.name,
            label: (id) => data.labelsById.get(id)?.name,
            priority: (value) => t(`issue.priority.${value}`),
            none: '–',
            someone: t('issue.activity.someone'),
          },
          (field) => t(`issue.field.${field}`),
        );
        return { row, text: t(key, vars) };
      }),
    [activity, data, t],
  );
  if (lines.length === 0) return null;
  return (
    <section className="issue-section-block" aria-label={t('issue.activity')}>
      <h3 className="issue-section-block__title">{t('issue.activity')}</h3>
      <ol className="issue-section-block__list">
        {lines.map(({ row, text }) => (
          <li key={row.id} data-testid="activity-row">
            {text}{' '}
            <span className="issue-section-block__meta">
              <time dateTime={row.created_at}>
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(row.created_at))}
              </time>
              {row.client ? ` · ${t('issue.activity.client', { client: row.client })}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
