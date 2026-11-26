import { useT } from '../../design/locale.tsx';
import { PriorityIcon } from '../icons.tsx';
import { PropertyPicker } from './PropertyPicker.tsx';

/** Urgent first, "no priority" last: the order a person thinks of them in. */
const PRIORITIES = [1, 2, 3, 4, 0];

export function PriorityPicker({
  value,
  onChange,
  onClose,
}: {
  value: number;
  onChange: (priority: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const options = PRIORITIES.map((priority) => ({
    id: String(priority),
    label: t(`issue.priority.${priority}`),
    icon: <PriorityIcon priority={priority} />,
  }));
  return (
    <PropertyPicker
      label={t('picker.priority')}
      options={options}
      selectedIds={[String(value)]}
      filterable={false}
      onPick={(option) => onChange(Number(option.id))}
      onClose={onClose}
    />
  );
}
