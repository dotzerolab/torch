// The display options of an issue view: layout, grouping, ordering, which properties a row shows. Plain data in and out
// (`ViewDisplay`); every change sends the whole display.
import {
  DEFAULT_DISPLAY,
  GROUPS,
  LAYOUTS,
  ORDERS,
  PROPERTY_IDS,
  type PropertyId,
  type ViewDisplay,
} from '@torch/shared/views';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '../design/components/Button.tsx';
import { Popover } from '../design/components/Popover.tsx';
import { useT } from '../design/locale.tsx';

/** Grouping offered on a team screen: the team is the same for every row, so grouping by it says nothing. */
export const TEAM_GROUPS = GROUPS.filter((group) => group !== 'team');

export function DisplayMenu({
  display,
  onChange,
  groups = TEAM_GROUPS,
}: {
  display: ViewDisplay;
  onChange: (next: ViewDisplay) => void;
  groups?: readonly ViewDisplay['group'][];
}) {
  const t = useT();
  const set = <K extends keyof ViewDisplay>(key: K, value: ViewDisplay[K]) =>
    onChange({ ...display, [key]: value });
  const toggleProperty = (id: PropertyId) => {
    const on = new Set(display.properties);
    if (on.has(id)) on.delete(id);
    else on.add(id);
    set(
      'properties',
      PROPERTY_IDS.filter((property) => on.has(property)),
    );
  };

  return (
    <Popover
      label={t('display.label')}
      align="end"
      className="display-menu"
      trigger={
        <Button size="sm" variant="ghost">
          <SlidersHorizontal size={14} aria-hidden="true" />
          {t('display.button')}
        </Button>
      }
    >
      <div className="display-menu__body">
        <div className="display-menu__row">
          <span id="display-layout">{t('display.layout')}</span>
          <div
            className="display-menu__segments"
            role="radiogroup"
            aria-labelledby="display-layout"
          >
            {LAYOUTS.map((layout) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control of two buttons; native radios are not styled as segments
              <button
                key={layout}
                type="button"
                role="radio"
                aria-checked={display.layout === layout}
                className="display-menu__segment"
                onClick={() => set('layout', layout)}
              >
                {t(`display.layout.${layout}`)}
              </button>
            ))}
          </div>
        </div>
        <label className="display-menu__row">
          <span>{t('display.group')}</span>
          <select
            className="field"
            value={groups.includes(display.group) ? display.group : groups[0]}
            onChange={(event) => set('group', event.target.value as ViewDisplay['group'])}
          >
            {groups.map((group) => (
              <option key={group} value={group}>
                {t(`display.group.${group}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="display-menu__row">
          <span>{t('display.order')}</span>
          <select
            className="field"
            value={display.order}
            onChange={(event) => set('order', event.target.value as ViewDisplay['order'])}
          >
            {ORDERS.map((order) => (
              <option key={order} value={order}>
                {t(`display.order.${order}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="display-menu__row">
          <span>{t('display.direction')}</span>
          <select
            className="field"
            value={display.direction}
            onChange={(event) => set('direction', event.target.value as ViewDisplay['direction'])}
          >
            {(['asc', 'desc'] as const).map((direction) => (
              <option key={direction} value={direction}>
                {t(`display.direction.${direction}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="display-menu__check">
          <input
            type="checkbox"
            checked={display.subIssues}
            onChange={(event) => set('subIssues', event.target.checked)}
          />
          {t('display.subIssues')}
        </label>
        <label className="display-menu__check">
          <input
            type="checkbox"
            checked={display.showEmptyGroups}
            onChange={(event) => set('showEmptyGroups', event.target.checked)}
          />
          {t('display.emptyGroups')}
        </label>
        <label className="display-menu__check">
          <input
            type="checkbox"
            checked={display.showArchived}
            onChange={(event) => set('showArchived', event.target.checked)}
          />
          {t('display.archived')}
        </label>
        <fieldset className="display-menu__properties">
          <legend>{t('display.properties')}</legend>
          {PROPERTY_IDS.map((id) => (
            <label key={id} className="display-menu__check">
              <input
                type="checkbox"
                checked={display.properties.includes(id)}
                onChange={() => toggleProperty(id)}
              />
              {t(`display.property.${id}`)}
            </label>
          ))}
        </fieldset>
        <Button size="sm" variant="ghost" onClick={() => onChange(DEFAULT_DISPLAY)}>
          {t('display.reset')}
        </Button>
      </div>
    </Popover>
  );
}
