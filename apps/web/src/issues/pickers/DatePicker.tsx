import { useT } from '../../design/locale.tsx';
import { addDays } from '../model/day.ts';
import { PropertyPicker } from './PropertyPicker.tsx';

/** Quick choices counted from `today`, and a date field for any other day. `null` clears the date. */
export function DatePicker({
  value,
  today,
  onChange,
  onClose,
}: {
  value: string | null;
  today: string;
  onChange: (day: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const quick = [
    { id: 'today', label: t('picker.date.today'), day: today },
    { id: 'tomorrow', label: t('picker.date.tomorrow'), day: addDays(today, 1) },
    { id: 'nextWeek', label: t('picker.date.nextWeek'), day: addDays(today, 7) },
  ];
  const options = [
    ...quick.map(({ id, label, day }) => ({ id, label, hint: day })),
    { id: 'clear', label: t('picker.date.clear') },
  ];
  return (
    <div className="picker-date">
      <PropertyPicker
        label={t('picker.dueDate')}
        options={options}
        selectedIds={quick.filter((entry) => entry.day === value).map((entry) => entry.id)}
        filterable={false}
        onPick={(option) =>
          onChange(
            option.id === 'clear'
              ? null
              : (quick.find((entry) => entry.id === option.id)?.day ?? null),
          )
        }
        onClose={onClose}
      />
      <input
        className="picker-date__input"
        type="date"
        aria-label={t('picker.date.pick')}
        value={value ?? ''}
        onChange={(event) => {
          if (event.target.value) {
            onChange(event.target.value);
            onClose();
          }
        }}
      />
    </div>
  );
}
