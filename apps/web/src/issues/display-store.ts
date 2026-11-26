// The last display options of a team on this device (`view-display:<scope>` in local storage). Storage may be blocked,
// full or hold something this version does not understand: every failure means "nothing stored".
import { type ViewDisplay, viewDisplaySchema } from '@torch/shared/views';

const key = (scope: string) => `view-display:${scope}`;

export function readStoredDisplay(scope: string): ViewDisplay | null {
  try {
    const raw = window.localStorage.getItem(key(scope));
    if (raw === null) return null;
    const parsed = viewDisplaySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeStoredDisplay(scope: string, display: ViewDisplay | null): void {
  try {
    if (display === null) window.localStorage.removeItem(key(scope));
    else window.localStorage.setItem(key(scope), JSON.stringify(display));
  } catch {
    // The view still works for this visit.
  }
}
