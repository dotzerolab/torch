// Which issues are selected on the screen (an issue list or a board). A selection is only ids: the screen that owns the
// rows decides what a bulk action does with them.
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

export type Selection = {
  ids: ReadonlySet<string>;
  /** Adds the issue, or takes it off when it is selected. */
  toggle: (id: string) => void;
  /** The selection is this issue alone. */
  only: (id: string) => void;
  /** Selects every issue between the last one touched and `to`, in the order of `ordered`. */
  range: (to: string, ordered: readonly string[]) => void;
  /** Adds (`on`) or removes (`!on`) these issues. */
  setMany: (ids: readonly string[], on: boolean) => void;
  clear: () => void;
};

const SelectionContext = createContext<Selection | undefined>(undefined);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);

  const toggle = useCallback((id: string) => {
    anchor.current = id;
    setIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const only = useCallback((id: string) => {
    anchor.current = id;
    setIds(new Set([id]));
  }, []);
  const range = useCallback((to: string, ordered: readonly string[]) => {
    const from = anchor.current ?? to;
    const a = ordered.indexOf(from);
    const b = ordered.indexOf(to);
    if (a < 0 || b < 0) {
      anchor.current = to;
      setIds((current) => new Set(current).add(to));
      return;
    }
    const [low, high] = a < b ? [a, b] : [b, a];
    setIds((current) => {
      const next = new Set(current);
      for (const id of ordered.slice(low, high + 1)) next.add(id);
      return next;
    });
  }, []);
  const setMany = useCallback((list: readonly string[], on: boolean) => {
    setIds((current) => {
      const next = new Set(current);
      for (const id of list) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    anchor.current = null;
    setIds(new Set());
  }, []);

  const value = useMemo(
    () => ({ ids, toggle, only, range, setMany, clear }),
    [ids, toggle, only, range, setMany, clear],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): Selection {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error('useSelection needs a SelectionProvider above it');
  return selection;
}
