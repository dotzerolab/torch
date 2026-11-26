// The screens of the signed-in app, by address. `parseRoute` turns a pathname into one of them; whatever it does not
// know is `home`, which the shell replaces with the first team.

export type Route =
  | { name: 'home' }
  | { name: 'team'; key: string }
  | { name: 'teamView'; key: string; viewId: string }
  | { name: 'issue'; identifier: string }
  | { name: 'myIssues' }
  | { name: 'settings' };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A team key, a dash and the number: the key itself may hold dashes. */
const IDENTIFIER = /^(.+)-\d+$/;

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  const [first, second, third, fourth] = parts;
  if (parts.length === 0) return { name: 'home' };
  if (first === 'settings') return { name: 'settings' };
  if (first === 'my-issues' && parts.length === 1) return { name: 'myIssues' };
  if (first === 'teams' && second !== undefined) {
    const key = decode(second);
    if (key === null) return { name: 'home' };
    if (parts.length === 2) return { name: 'team', key };
    if (parts.length === 4 && third === 'views' && fourth !== undefined && GUID.test(fourth)) {
      return { name: 'teamView', key, viewId: fourth.toLowerCase() };
    }
    return { name: 'home' };
  }
  if (first === 'issues' && second !== undefined && parts.length === 2) {
    const identifier = decode(second);
    if (identifier !== null && IDENTIFIER.test(identifier)) return { name: 'issue', identifier };
  }
  return { name: 'home' };
}

/** The key of the team a screen is about (`/issues/ENG-12` is about `ENG`), or null for the screens of no one team. */
export function routeTeamKey(route: Route): string | null {
  switch (route.name) {
    case 'team':
    case 'teamView':
      return route.key;
    case 'issue':
      return IDENTIFIER.exec(route.identifier)?.[1] ?? null;
    default:
      return null;
  }
}

/** `ENG-12` as its team key and number; the key itself may hold dashes. Null for anything else. */
export function splitIdentifier(identifier: string): { key: string; number: number } | null {
  const match = /^(.+)-(\d+)$/.exec(identifier);
  if (!match) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? { key: match[1] as string, number } : null;
}
