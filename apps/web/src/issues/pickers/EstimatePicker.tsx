import { useMemo } from 'react';
import { useT } from '../../design/locale.tsx';
import { PropertyPicker } from './PropertyPicker.tsx';

/** The estimates offered (builder decision 6); the server accepts 0 to 64, so an issue may hold another value. */
export const ESTIMATE_SCALE = [0, 1, 2, 3, 5, 8, 13, 21] as const;

const NONE = 'none';

export function EstimatePicker({
  value,
  onChange,
  onClose,
}: {
  value: number | null;
  onChange: (estimate: number | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const options = useMemo(() => {
    const scale: number[] = [...ESTIMATE_SCALE];
    // An estimate outside the scale stays visible, in its place, so the current value is not blank.
    if (value !== null && !scale.includes(value)) scale.push(value);
    scale.sort((a, b) => a - b);
    return [
      { id: NONE, label: t('picker.estimate.none') },
      ...scale.map((n) => ({ id: String(n), label: String(n) })),
    ];
  }, [value, t]);
  return (
    <PropertyPicker
      label={t('picker.estimate')}
      options={options}
      selectedIds={[value === null ? NONE : String(value)]}
      filterable={false}
      onPick={(option) => onChange(option.id === NONE ? null : Number(option.id))}
      onClose={onClose}
    />
  );
}
