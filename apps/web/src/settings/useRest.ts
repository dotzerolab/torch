import { useCallback, useEffect, useRef, useState } from 'react';

export type RestState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown };

/**
 * Loads a REST list once when the screen mounts and again on `reload()` (after a write). A reload keeps the old data
 * on screen until the new one is there, so the list never blinks.
 */
export function useRest<T>(load: () => Promise<T>): {
  state: RestState<T>;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<RestState<T>>({ status: 'loading' });
  const loader = useRef(load);
  loader.current = load;
  // A newer request makes an older answer irrelevant, and an unmounted screen has nobody to tell.
  const latest = useRef(0);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const data = await loader.current();
      if (mounted.current && mine === latest.current) setState({ status: 'ready', data });
    } catch (error) {
      if (mounted.current && mine === latest.current) setState({ status: 'error', error });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  return { state, reload };
}
