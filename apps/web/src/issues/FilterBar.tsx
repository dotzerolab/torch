// The filter of an issue view: "+ Filter" (field, then values), one chip per chosen value, a text field and Clear. The
// filter itself is plain data (`ViewFilter`); this component only edits it.
import type { ViewFilter } from '@torch/shared/views';
import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../design/components/Avatar.tsx';
import { Button } from '../design/components/Button.tsx';
import { Input } from '../design/components/Input.tsx';
import { Popover } from '../design/components/Popover.tsx';
import { useT } from '../design/locale.tsx';
import { useShortcut } from '../keys/useShortcut.ts';
import type { TeamData } from './data.ts';
import { PriorityIcon, StateDot } from './icons.tsx';
import { type PickerOption, PropertyPicker } from './pickers/PropertyPicker.tsx';
import { StaleChip } from './StaleChip.tsx';

/** The fields "+ Filter" offers. (`stateType` is only ever set by a link.) */
const FIELDS = ['state', 'assignee', 'creator', 'priority', 'label', 'due'] as const;
type Field = (typeof FIELDS)[number];
const CHIP_FIELDS = [
  'state',
  'stateType',
  'assignee',
  'creator',
  'priority',
  'label',
  'due',
] as const;
type ChipField = (typeof CHIP_FIELDS)[number];
type Value = string | number;

const ME = 'me';
const NONE = 'none';

function without(filter: ViewFilter, field: ChipField, value: Value): ViewFilter {
  const kept = ((filter[field] ?? []) as Value[]).filter((item) => item !== value);
  const next = { ...filter } as Record<string, unknown>;
  if (kept.length > 0) next[field] = kept;
  else delete next[field];
  return next as ViewFilter;
}

export function FilterBar({
  filter,
  onChange,
  data,
  meId,
}: {
  filter: ViewFilter;
  onChange: (next: ViewFilter) => void;
  data: TeamData;
  meId: string;
}) {
  const t = useT();
  const [menu, setMenu] = useState<null | 'fields' | Field>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useShortcut({ id: 'filter.open', keys: 'f', labelKey: 'shortcuts.filter.open' }, () =>
    setMenu('fields'),
  );
  useShortcut({ id: 'filter.search', keys: '/', labelKey: 'shortcuts.filter.search' }, () =>
    searchRef.current?.focus(),
  );

  // The text is typed into a draft so a trailing space survives (the address keeps the trimmed text); it follows the
  // filter when something else changes it (Clear, the back button).
  const [draft, setDraft] = useState(filter.text ?? '');
  useEffect(() => {
    setDraft((current) => ((filter.text ?? '') === current.trim() ? current : (filter.text ?? '')));
  }, [filter.text]);

  const me = data.membersById.get(meId);
  const person = (id: string): { text: string; stale: boolean; loading: boolean } => {
    if (id === ME) return { text: t('picker.assignee.me'), stale: false, loading: false };
    if (id === NONE) return { text: t('picker.assignee.none'), stale: false, loading: false };
    const member = data.membersById.get(id);
    if (member && member.deactivated_at === null)
      return { text: member.name, stale: false, loading: false };
    return { text: '', stale: data.ready, loading: !data.ready };
  };

  /** What a chip says about one value, and whether it still names something. */
  const chipOf = (
    field: ChipField,
    value: Value,
  ): { text: string; stale: 'state' | 'label' | 'person' | null } => {
    switch (field) {
      case 'state': {
        const state = data.statesById.get(String(value));
        if (state && state.archived_at === null) return { text: state.name, stale: null };
        return { text: t('filter.loading'), stale: data.statesReady ? 'state' : null };
      }
      case 'stateType':
        return { text: t(`issue.stateType.${value}`), stale: null };
      case 'assignee':
      case 'creator': {
        const found = person(String(value));
        return {
          text: found.loading ? t('filter.loading') : found.text,
          stale: found.stale ? 'person' : null,
        };
      }
      case 'priority':
        return { text: t(`issue.priority.${value}`), stale: null };
      case 'label': {
        const label = data.labelsById.get(String(value));
        if (label && label.archived_at === null) return { text: label.name, stale: null };
        return { text: t('filter.loading'), stale: data.ready ? 'label' : null };
      }
      case 'due':
        return { text: t(`filter.due.${value}`), stale: null };
    }
  };

  const chips = CHIP_FIELDS.flatMap((field) =>
    ((filter[field] ?? []) as Value[]).map((value) => ({
      field,
      value,
      ...chipOf(field, value),
    })),
  );
  const active = chips.length > 0 || Boolean(filter.text);

  const optionsFor = (field: Field): PickerOption[] => {
    const chosen = new Set(((filter[field] ?? []) as Value[]).map(String));
    switch (field) {
      case 'state':
        return data.states
          .filter((state) => state.archived_at === null || chosen.has(state.id))
          .map((state) => ({
            id: state.id,
            label: state.name,
            icon: <StateDot color={state.color} />,
            hint: t(`issue.stateType.${state.type}`),
          }));
      case 'assignee':
      case 'creator': {
        const others = data.members.filter((member) => member.id !== meId);
        return [
          ...(field === 'assignee' ? [{ id: NONE, label: t('picker.assignee.none') }] : []),
          {
            id: ME,
            label: t('picker.assignee.me'),
            hint: me?.name,
            icon: me ? <Avatar name={me.name} size="sm" /> : undefined,
          },
          ...others.map((member) => ({
            id: member.id,
            label: member.name,
            icon: <Avatar name={member.name} size="sm" />,
          })),
        ];
      }
      case 'priority':
        return [1, 2, 3, 4, 0].map((priority) => ({
          id: String(priority),
          label: t(`issue.priority.${priority}`),
          icon: <PriorityIcon priority={priority} />,
        }));
      case 'label':
        return data.labels
          .filter((label) => !label.is_group)
          .map((label) => ({
            id: label.id,
            label: label.name,
            icon: <StateDot color={label.color} />,
          }));
      case 'due':
        return (['overdue', 'week', 'none'] as const).map((due) => ({
          id: due,
          label: t(`filter.due.${due}`),
        }));
    }
  };

  const toggle = (field: Field, option: PickerOption) => {
    const value: Value = field === 'priority' ? Number(option.id) : option.id;
    const current = (filter[field] ?? []) as Value[];
    if (current.includes(value)) onChange(without(filter, field, value));
    else onChange({ ...filter, [field]: [...current, value] } as ViewFilter);
  };

  const setText = (value: string) => {
    setDraft(value);
    const next = { ...filter };
    if (value.trim()) next.text = value;
    else delete next.text;
    onChange(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a wrapping row of controls; a fieldset would add a border and a legend
    <div className="filter-bar" role="group" aria-label={t('filter.label')}>
      <Popover
        open={menu !== null}
        onOpenChange={(open) => setMenu(open ? 'fields' : null)}
        label={t('filter.addField')}
        trigger={
          <Button size="sm" variant="ghost" className="filter-bar__add">
            <Plus size={14} aria-hidden="true" />
            {t('filter.add')}
          </Button>
        }
      >
        {menu === 'fields' || menu === null ? (
          <ul className="filter-bar__fields">
            {FIELDS.map((field) => (
              <li key={field}>
                <button type="button" className="filter-bar__field" onClick={() => setMenu(field)}>
                  {t(`filter.field.${field}`)}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <FieldValues
            key={menu}
            label={t(`filter.field.${menu}`)}
            options={optionsFor(menu)}
            selected={((filter[menu] ?? []) as Value[]).map(String)}
            filterable={
              menu === 'label' || menu === 'state' || menu === 'assignee' || menu === 'creator'
            }
            onPick={(option) => toggle(menu, option)}
            onClose={() => setMenu(null)}
          />
        )}
      </Popover>
      {chips.map((chip) =>
        chip.stale ? (
          <StaleChip
            key={`${chip.field}:${chip.value}`}
            kind={chip.stale}
            onRemove={() => onChange(without(filter, chip.field, chip.value))}
          />
        ) : (
          <span key={`${chip.field}:${chip.value}`} className="chip">
            <span className="chip__text">{`${t(`filter.field.${chip.field}`)}: ${chip.text}`}</span>
            <button
              type="button"
              className="chip__remove"
              aria-label={t('filter.remove', {
                name: `${t(`filter.field.${chip.field}`)}: ${chip.text}`,
              })}
              onClick={() => onChange(without(filter, chip.field, chip.value))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ),
      )}
      <Input
        ref={searchRef}
        type="search"
        className="filter-bar__text"
        aria-label={t('filter.text')}
        placeholder={t('filter.text')}
        value={draft}
        maxLength={200}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') (event.target as HTMLElement).blur();
        }}
      />
      {active ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft('');
            onChange({});
          }}
        >
          {t('filter.clear')}
        </Button>
      ) : null}
    </div>
  );
}

function FieldValues({
  label,
  options,
  selected,
  filterable,
  onPick,
  onClose,
}: {
  label: string;
  options: PickerOption[];
  selected: string[];
  filterable: boolean;
  onPick: (option: PickerOption) => void;
  onClose: () => void;
}) {
  const stable = useMemo(() => options, [options]);
  return (
    <PropertyPicker
      label={label}
      options={stable}
      selectedIds={selected}
      onPick={onPick}
      onClose={onClose}
      filterable={filterable}
      keepOpen
    />
  );
}
