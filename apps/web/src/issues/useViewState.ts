// The view of an issue screen: the filter and the display options. They live in the address (a link carries them, the
// back button walks through them); when the address names no display option, the last ones used for this scope on this
// device apply, then the defaults. Changing either rewrites the address in place (no history entry per keystroke).
import { DEFAULT_DISPLAY, type ViewDisplay, type ViewFilter } from '@torch/shared/views';
import { useCallback, useMemo, useRef, useState } from 'react';
import { navigate, useLocation } from '../navigation.ts';
import { readStoredDisplay, writeStoredDisplay } from './display-store.ts';
import { decodeView, withView } from './model/url.ts';

export type ViewState = {
  filter: ViewFilter;
  display: ViewDisplay;
  setFilter: (next: ViewFilter) => void;
  setDisplay: (next: ViewDisplay) => void;
};

/** What differs from the defaults: all the address needs to say. */
function changed(display: ViewDisplay, base: ViewDisplay): Partial<ViewDisplay> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(DEFAULT_DISPLAY) as (keyof ViewDisplay)[]) {
    if (JSON.stringify(display[name]) !== JSON.stringify(base[name])) out[name] = display[name];
  }
  return out as Partial<ViewDisplay>;
}

/**
 * `scope` names what the display options are remembered for: a team id, or `my-issues`. `base` is what the screen opens
 * on when neither the address nor the device says otherwise; the address names only what differs from it.
 */
export function useViewState(scope: string, base: ViewDisplay = DEFAULT_DISPLAY): ViewState {
  const { pathname, search } = useLocation();
  const decoded = useMemo(() => decodeView(new URLSearchParams(search)), [search]);
  const fromAddress = Object.keys(decoded.display).length > 0;
  // The device is read when the address has nothing to say, again when the scope changes and after a write of ours.
  const [written, setWritten] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `written` is the signal that the stored copy changed
  const stored = useMemo(
    () => (fromAddress ? null : readStoredDisplay(scope)),
    [fromAddress, scope, written],
  );
  const display = useMemo<ViewDisplay>(
    () => ({ ...base, ...(stored ?? {}), ...decoded.display }),
    [base, stored, decoded.display],
  );

  const latest = useRef({ pathname, search, filter: decoded.filter, display });
  latest.current = { pathname, search, filter: decoded.filter, display };

  const write = useCallback(
    (filter: ViewFilter, next: ViewDisplay, remember: ViewDisplay) => {
      const { pathname: path, search: current } = latest.current;
      writeStoredDisplay(scope, remember);
      setWritten((count) => count + 1);
      // The default is the absence of a parameter: the address stays short.
      navigate(`${path}${withView(current, filter, changed(next, base))}`, { replace: true });
    },
    [scope, base],
  );

  const setFilter = useCallback(
    (next: ViewFilter) => write(next, latest.current.display, latest.current.display),
    [write],
  );
  const setDisplay = useCallback(
    (next: ViewDisplay) => write(latest.current.filter, next, next),
    [write],
  );
  return useMemo(
    () => ({ filter: decoded.filter, display, setFilter, setDisplay }),
    [decoded.filter, display, setFilter, setDisplay],
  );
}
