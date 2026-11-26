import { useMemo, useSyncExternalStore } from 'react';

// A few plain routes (`routes.ts`) need no router library yet. An address is a path with an optional query: the query
// carries the filters and display options of an issue view, so the back button walks through them.

/** `to` is a path, optionally with a query (`/teams/ENG?group=assignee`). */
export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (options.replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

const where = () => `${window.location.pathname}${window.location.search}`;

/** The address of the page, re-read on every navigation and on the back and forward buttons. */
export function useLocation(): { pathname: string; search: string } {
  const current = useSyncExternalStore(subscribe, where, () => '/');
  return useMemo(() => {
    const at = current.indexOf('?');
    return at < 0
      ? { pathname: current, search: '' }
      : { pathname: current.slice(0, at), search: current.slice(at) };
  }, [current]);
}

export function usePathname(): string {
  return useLocation().pathname;
}
