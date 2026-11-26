import { useMemo } from 'react';
import { useT } from '../../design/locale.tsx';
import type { SyncedLabel } from '../../sync/collections.ts';
import { StateDot } from '../icons.tsx';
import { PropertyPicker } from './PropertyPicker.tsx';

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** What a change of the label set comes to, in the words of the update the server takes. */
export function labelDiff(
  before: readonly string[],
  after: readonly string[],
): { addLabelIds: string[]; removeLabelIds: string[] } {
  return {
    addLabelIds: after.filter((id) => !before.includes(id)),
    removeLabelIds: before.filter((id) => !after.includes(id)),
  };
}

/**
 * Labels of the team and of the workspace, many at once. A group is a heading: its labels are alternatives, so choosing
 * one takes its siblings off (the server does the same). An archived label shows only while the issue still has it.
 */
export function LabelPicker({
  labels,
  value,
  onChange,
  onClose,
}: {
  labels: readonly SyncedLabel[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { options, parentOf } = useMemo(() => {
    const usable = labels.filter((label) => label.archived_at === null || value.includes(label.id));
    const sorted = [...usable].sort((a, b) => byName.compare(a.name, b.name));
    const parentOf = new Map(sorted.map((label) => [label.id, label.parent_id]));
    const scope = (label: SyncedLabel) =>
      label.team_id === null ? t('picker.label.workspace') : t('picker.label.team');
    const item = (label: SyncedLabel) => ({
      id: label.id,
      label: label.name,
      hint: scope(label),
      icon: <StateDot color={label.color} />,
    });
    const groups = sorted.filter((label) => label.is_group);
    const grouped = groups.flatMap((group) => {
      const children = sorted.filter((label) => label.parent_id === group.id && !label.is_group);
      return children.length > 0
        ? [{ id: group.id, label: group.name, heading: true }, ...children.map(item)]
        : [];
    });
    const groupIds = new Set(groups.map((group) => group.id));
    const loose = sorted
      .filter(
        (label) => !label.is_group && (label.parent_id === null || !groupIds.has(label.parent_id)),
      )
      .map(item);
    return { options: [...grouped, ...loose], parentOf };
  }, [labels, value, t]);

  return (
    <PropertyPicker
      label={t('picker.labels')}
      options={options}
      selectedIds={value}
      keepOpen
      onPick={(option) => {
        if (value.includes(option.id)) {
          onChange(value.filter((id) => id !== option.id));
          return;
        }
        const group = parentOf.get(option.id);
        const kept = group ? value.filter((id) => parentOf.get(id) !== group) : [...value];
        onChange([...kept, option.id]);
      }}
      onClose={onClose}
    />
  );
}
