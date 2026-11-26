// The relations of an issue, from its own end. An end that is not among the issues this screen has (an issue of a team
// the person cannot see) is "Issue you cannot see": the shape carries ids only, so there is no title or number to show.
import { RELATION_INPUT_TYPES } from '@torch/shared/mutations/issue';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../design/components/Button.tsx';
import { Input } from '../design/components/Input.tsx';
import { useT } from '../design/locale.tsx';
import { navigate } from '../navigation.ts';
import type { RelationView } from './model/detail.ts';
import type { IssueRow } from './model/engine.ts';

const MAX_RESULTS = 8;
type InputType = (typeof RELATION_INPUT_TYPES)[number];

export function Relations({
  relations,
  rows,
  self,
  readOnly,
  onAdd,
  onRemove,
}: {
  relations: RelationView[];
  /** The issues this screen has (the team's). */
  rows: readonly IssueRow[];
  self: IssueRow;
  readOnly: boolean;
  onAdd: (type: InputType, otherId: string) => void;
  onRemove: (relationId: string) => void;
}) {
  const t = useT();
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const [type, setType] = useState<InputType>('blocks');
  const [query, setQuery] = useState('');
  const found = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return [];
    const taken = new Set(relations.map((relation) => relation.otherId));
    const matches: IssueRow[] = [];
    for (const row of rows) {
      if (row.id === self.id || taken.has(row.id)) continue;
      if (
        row.identifier.toLowerCase().includes(text) ||
        row.issue.title.toLowerCase().includes(text)
      ) {
        matches.push(row);
        if (matches.length >= MAX_RESULTS) break;
      }
    }
    return matches;
  }, [query, rows, relations, self.id]);

  if (relations.length === 0 && readOnly) return null;
  return (
    <section className="issue-section-block" aria-label={t('issue.relations')}>
      <h3 className="issue-section-block__title">{t('issue.relations')}</h3>
      <ul className="issue-section-block__list">
        {relations.map((relation) => {
          const other = byId.get(relation.otherId);
          const name = other ? `${other.identifier} ${other.issue.title}` : t('issue.hidden');
          return (
            <li key={relation.id} data-testid={`relation-${relation.kind}`}>
              <span className="issue-section-block__name">
                {t(`issue.relation.${relation.kind}`)}
              </span>
              {other ? (
                <button
                  type="button"
                  className="issue-link"
                  onClick={() => other.identifier && navigate(`/issues/${other.identifier}`)}
                >
                  {name}
                </button>
              ) : (
                <span className="issue-link issue-link--hidden" data-testid="relation-hidden">
                  {name}
                </span>
              )}
              {readOnly ? null : (
                <button
                  type="button"
                  className="chip__remove"
                  aria-label={t('issue.relation.remove', { issue: name })}
                  onClick={() => onRemove(relation.id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {readOnly ? null : (
        <div className="issue-section-block__add">
          <select
            className="field"
            aria-label={t('issue.relation.type')}
            value={type}
            onChange={(event) => setType(event.target.value as InputType)}
          >
            {RELATION_INPUT_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`issue.relation.${value}`)}
              </option>
            ))}
          </select>
          <Input
            type="search"
            aria-label={t('issue.relation.search')}
            placeholder={t('issue.relation.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {found.length > 0 ? (
            <ul className="issue-section-block__results">
              {found.map((row) => (
                <li key={row.id}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onAdd(type, row.id);
                      setQuery('');
                    }}
                  >
                    {`${row.identifier} ${row.issue.title}`}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}
