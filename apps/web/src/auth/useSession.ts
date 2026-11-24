import { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../api.ts';

export type SessionWorkspace = {
  id: string;
  name: string;
  slug: string;
  memberId: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
};

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; workspaces: SessionWorkspace[] }
  | { status: 'error' };

/** Who the cookie says is signed in, read once when the screen mounts. */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ workspaces: SessionWorkspace[] }>('/api/auth/session', {
      signal: controller.signal,
    }).then(
      ({ workspaces }) => setState({ status: 'signed-in', workspaces }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) setState({ status: 'signed-out' });
        else setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, []);

  return state;
}

/**
 * Ends the session on the server, then (unless `navigate` is false) reloads onto /login so nothing of the signed-in
 * page stays in memory. The sign-out flow of the shell passes `false`: it wipes the device copy first.
 */
export async function signOut({ navigate = true }: { navigate?: boolean } = {}): Promise<void> {
  try {
    await apiFetch<undefined>('/api/auth/logout', { method: 'POST' });
  } finally {
    if (navigate) window.location.assign('/login');
  }
}
