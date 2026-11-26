// The sub-issues of an issue (rows of the team's loaded issues whose parent it is), how far they are, and the parent.
import { useT } from '../design/locale.tsx';
import { navigate } from '../navigation.ts';
import type { TeamData } from './data.ts';
import { StateDot } from './icons.tsx';
import type { IssueRow } from './model/engine.ts';

const open = (row: IssueRow) => row.identifier && navigate(`/issues/${row.identifier}`);

export function SubIssues({
  parent,
  subIssues,
  done,
  data,
}: {
  parent: IssueRow | undefined;
  subIssues: IssueRow[];
  done: number;
  data: Pick<TeamData, 'statesById'>;
}) {
  const t = useT();
  if (!parent && subIssues.length === 0) return null;
  const link = (row: IssueRow) => (
    <button type="button" className="issue-link" onClick={() => open(row)}>
      <span className="issue-row__id">{row.identifier}</span> {row.issue.title}
    </button>
  );
  return (
    <section className="issue-section-block" aria-label={t('issue.subIssues')}>
      {parent ? (
        <p className="issue-section-block__line" data-testid="issue-parent">
          <span className="issue-section-block__name">{t('issue.parent')}</span> {link(parent)}
        </p>
      ) : null}
      {subIssues.length > 0 ? (
        <>
          <h3 className="issue-section-block__title">
            {t('issue.subIssues')}
            <span className="issue-section__count" data-testid="sub-issue-progress">
              {t('issue.subIssues.progress', {
                done: String(done),
                total: String(subIssues.length),
              })}
            </span>
          </h3>
          <ul className="issue-section-block__list">
            {subIssues.map((row) => (
              <li key={row.id} data-testid={`sub-issue-${row.issue.number}`}>
                <StateDot
                  color={data.statesById.get(row.issue.state_id)?.color ?? 'var(--fg-subtle)'}
                />
                {link(row)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
