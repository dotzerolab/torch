// The list every property picker is made of: a filter field, a listbox of options, arrow keys and Enter (the field keeps
// focus and names the active option with `aria-activedescendant`). A picker lives inside a popover; this is its content.
import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../design/locale.tsx';

export type PickerOption = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Quiet text after the label (the type of a state, the scope of a label). */
  hint?: string;
  /** A heading is shown as plain text and cannot be picked (a label group). */
  heading?: boolean;
  disabled?: boolean;
};

const matches = (option: PickerOption, query: string) => option.label.toLowerCase().includes(query);

export function PropertyPicker({
  label,
  options,
  selectedIds,
  onPick,
  onClose,
  filterable = true,
  keepOpen = false,
}: {
  /** The name of the list for assistive technology ("State"). */
  label: string;
  options: PickerOption[];
  selectedIds: readonly string[];
  onPick: (option: PickerOption) => void;
  onClose: () => void;
  filterable?: boolean;
  /** A multi-select picker: picking toggles and the list stays open. */
  keepOpen?: boolean;
}) {
  const t = useT();
  const listId = useId();
  const [query, setQuery] = useState('');
  const text = query.trim().toLowerCase();

  // A heading stays while one of the options under it matches.
  const shown = useMemo(() => {
    if (!text) return options;
    const kept: PickerOption[] = [];
    options.forEach((option, index) => {
      if (option.heading) {
        let next = index + 1;
        let any = false;
        while (next < options.length && !options[next]?.heading) {
          if (matches(options[next] as PickerOption, text)) any = true;
          next += 1;
        }
        if (any) kept.push(option);
      } else if (matches(option, text)) kept.push(option);
    });
    return kept;
  }, [options, text]);

  const pickable = shown.filter((option) => !option.heading && !option.disabled);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Starts on the selected option, else the first; stays where it is while the filter still shows it.
  const active =
    pickable.find((option) => option.id === activeId) ??
    pickable.find((option) => selected.has(option.id)) ??
    pickable[0] ??
    null;
  const optionId = (id: string) => `${listId}-${id}`;

  const move = (to: number) => {
    const next = pickable[Math.max(0, Math.min(pickable.length - 1, to))];
    if (next) setActiveId(next.id);
  };
  const at = active ? pickable.indexOf(active) : -1;

  const activeNode = active ? optionId(active.id) : undefined;
  useEffect(() => {
    if (activeNode) document.getElementById(activeNode)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeNode]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (filterable ? inputRef.current : listRef.current)?.focus();
  }, [filterable]);

  const pick = (option: PickerOption) => {
    if (option.heading || option.disabled) return;
    onPick(option);
    if (!keepOpen) onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(at + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(at - 1);
        break;
      case 'Home':
        if (!filterable) {
          event.preventDefault();
          move(0);
        }
        break;
      case 'End':
        if (!filterable) {
          event.preventDefault();
          move(pickable.length - 1);
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (active) pick(active);
        break;
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
    }
  };

  return (
    // The keys are the picker's own: its field (or list) has the focus.
    // biome-ignore lint/a11y/noStaticElementInteractions: key handling of the focused combobox inside
    <div className="picker" onKeyDown={onKeyDown}>
      {filterable ? (
        <input
          ref={inputRef}
          className="picker__filter"
          role="combobox"
          aria-label={t('picker.filter')}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeNode}
          placeholder={t('picker.filter')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      <div
        ref={listRef}
        id={listId}
        className="picker__list"
        role="listbox"
        aria-label={label}
        aria-multiselectable={keepOpen || undefined}
        tabIndex={filterable ? -1 : 0}
        aria-activedescendant={filterable ? undefined : activeNode}
      >
        {shown.map((option) =>
          option.heading ? (
            <div key={option.id} className="picker__heading" role="presentation">
              {option.label}
            </div>
          ) : (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox that holds the focus handles the keys
            <div
              key={option.id}
              id={optionId(option.id)}
              className="picker__option"
              role="option"
              aria-selected={selected.has(option.id)}
              aria-disabled={option.disabled || undefined}
              data-active={active?.id === option.id ? 'true' : undefined}
              onMouseMove={() => !option.disabled && setActiveId(option.id)}
              onClick={() => pick(option)}
              tabIndex={-1}
            >
              {option.icon ? <span className="picker__icon">{option.icon}</span> : null}
              <span className="picker__label">{option.label}</span>
              {option.hint ? <span className="picker__hint">{option.hint}</span> : null}
              {selected.has(option.id) ? (
                <Check className="picker__check" size={14} aria-hidden="true" />
              ) : null}
            </div>
          ),
        )}
        {shown.length === 0 ? (
          <div className="picker__empty" role="presentation">
            {t('picker.empty')}
          </div>
        ) : null}
      </div>
    </div>
  );
}
