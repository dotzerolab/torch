import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

export type SelectOption = { value: string; label: string; icon?: ReactNode };

/** A single choice from a short list. `label` names it for assistive technology (there is no visible label). */
export function Select({
  value,
  onValueChange,
  options,
  label,
  disabled = false,
  placeholder,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  disabled?: boolean;
  /** Shown while `value` is empty. */
  placeholder?: string;
}) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger className="select__trigger" aria-label={label}>
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="select__chevron">
          <ChevronDown size={14} aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="select__content" position="popper" sideOffset={6}>
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item key={option.value} value={option.value} className="select__item">
                {option.icon ? <span className="select__icon">{option.icon}</span> : null}
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="select__check">
                  <Check size={14} aria-hidden="true" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
