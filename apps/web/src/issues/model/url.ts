// A view in the address bar: filters and display options as query parameters, so a link carries them and the back button
// walks through them. `encodeView` writes exactly what it is given; `decodeView` reads back only what is valid and
// leaves the rest out (a link that names an id of another workspace, or an option this version does not know, opens the
// view without it instead of failing).
import {
  DUE_FILTERS,
  GROUPS,
  LAYOUTS,
  MAX_FILTER_TEXT_LENGTH,
  ORDERS,
  PROPERTY_IDS,
  type PropertyId,
  VIEW_STATE_TYPES,
  type ViewDisplay,
  type ViewFilter,
} from '@torch/shared/views';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The values of one parameter that `accept` takes, in order, without repeats; null when the parameter is absent. */
function values<T extends string | number>(
  params: URLSearchParams,
  name: string,
  accept: (item: string) => T | undefined,
): T[] | null {
  const raw = params.get(name);
  if (raw === null) return null;
  const found: T[] = [];
  for (const item of raw.split(',')) {
    const value = accept(item.trim());
    if (value !== undefined && !found.includes(value)) found.push(value);
  }
  return found;
}

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (item: string): T | undefined =>
    (allowed as readonly string[]).includes(item) ? (item as T) : undefined;

const guid = (item: string) => (GUID.test(item) ? item.toLowerCase() : undefined);
const person =
  (...shortcuts: string[]) =>
  (item: string) =>
    shortcuts.includes(item) ? item : guid(item);
const priority = (item: string) => {
  const value = Number(item);
  return item !== '' && Number.isInteger(value) && value >= 0 && value <= 4 ? value : undefined;
};

const flag = (params: URLSearchParams, name: string): boolean | undefined => {
  const raw = params.get(name);
  return raw === '1' ? true : raw === '0' ? false : undefined;
};
const choice = <T extends string>(
  params: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined => oneOf(allowed)(params.get(name) ?? '');

export function encodeView(filter: ViewFilter, display: Partial<ViewDisplay>): URLSearchParams {
  const params = new URLSearchParams();
  const list = (name: string, items: readonly (string | number)[] | undefined) => {
    if (items && items.length > 0) params.set(name, items.join(','));
  };
  list('state', filter.state);
  list('stateType', filter.stateType);
  list('assignee', filter.assignee);
  list('creator', filter.creator);
  list('priority', filter.priority);
  list('label', filter.label);
  list('due', filter.due);
  const text = filter.text?.trim();
  if (text) params.set('text', text);

  if (display.layout) params.set('layout', display.layout);
  if (display.group) params.set('group', display.group);
  if (display.order) params.set('order', display.order);
  if (display.direction) params.set('dir', display.direction);
  if (display.subIssues !== undefined) params.set('sub', display.subIssues ? '1' : '0');
  // An empty list is a choice too (show no property), so it is written.
  if (display.properties) params.set('props', display.properties.join(','));
  if (display.showEmptyGroups !== undefined)
    params.set('empty', display.showEmptyGroups ? '1' : '0');
  if (display.showArchived !== undefined) params.set('archived', display.showArchived ? '1' : '0');
  return params;
}

export function decodeView(params: URLSearchParams): {
  filter: ViewFilter;
  display: Partial<ViewDisplay>;
} {
  const filter: ViewFilter = {};
  const take = <K extends keyof ViewFilter>(key: K, found: ViewFilter[K] | null) => {
    if (found && found.length > 0) filter[key] = found;
  };
  take('state', values(params, 'state', guid));
  take('stateType', values(params, 'stateType', oneOf(VIEW_STATE_TYPES)));
  take('assignee', values(params, 'assignee', person('me', 'none')));
  take('creator', values(params, 'creator', person('me')));
  take('priority', values(params, 'priority', priority));
  take('label', values(params, 'label', guid));
  take('due', values(params, 'due', oneOf(DUE_FILTERS)));
  const text = params.get('text')?.trim();
  if (text && text.length <= MAX_FILTER_TEXT_LENGTH) filter.text = text;

  const display: Partial<ViewDisplay> = {};
  const layout = choice(params, 'layout', LAYOUTS);
  if (layout) display.layout = layout;
  const group = choice(params, 'group', GROUPS);
  if (group) display.group = group;
  const order = choice(params, 'order', ORDERS);
  if (order) display.order = order;
  const direction = choice(params, 'dir', ['asc', 'desc'] as const);
  if (direction) display.direction = direction;
  const subIssues = flag(params, 'sub');
  if (subIssues !== undefined) display.subIssues = subIssues;
  const properties = values<PropertyId>(params, 'props', oneOf(PROPERTY_IDS));
  if (properties) display.properties = properties;
  const showEmptyGroups = flag(params, 'empty');
  if (showEmptyGroups !== undefined) display.showEmptyGroups = showEmptyGroups;
  const showArchived = flag(params, 'archived');
  if (showArchived !== undefined) display.showArchived = showArchived;
  return { filter, display };
}
