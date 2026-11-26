import { useMemo } from 'react';
import { useT } from '../../design/locale.tsx';
import type { SyncedWorkflowState } from '../../sync/collections.ts';
import { StateDot } from '../icons.tsx';
import { PropertyPicker } from './PropertyPicker.tsx';

/** The states of a team in workflow order, with their type. An archived state shows only while the issue is in it. */
export function StatePicker({
  states,
  value,
  onChange,
  onClose,
}: {
  states: readonly SyncedWorkflowState[];
  value: string | null;
  onChange: (stateId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const options = useMemo(
    () =>
      [...states]
        .filter((state) => state.archived_at === null || state.id === value)
        .sort((a, b) => a.position - b.position)
        .map((state) => ({
          id: state.id,
          label: state.name,
          icon: <StateDot color={state.color} />,
          hint: t(`issue.stateType.${state.type}`),
        })),
    [states, value, t],
  );
  return (
    <PropertyPicker
      label={t('picker.state')}
      options={options}
      selectedIds={value ? [value] : []}
      onPick={(option) => onChange(option.id)}
      onClose={onClose}
    />
  );
}
