import type { ElectricConfig } from './config.ts';

export type SyncHealth = { status: 'ok' | 'disabled' | 'error'; reason?: string };

/** The longest the check waits: a health probe must answer, not hang with the sync service. */
const SYNC_HEALTH_TIMEOUT_MS = 2000;

/**
 * Asks the sync service for its state (`GET /v1/health`, which needs no secret). Without `ELECTRIC_URL` sync is off
 * and that is not an error. The endpoint is unauthenticated, so every failure is reduced to a category: the text of a
 * failed fetch can carry the URL, and a response body can describe the configuration.
 */
export async function checkSyncHealth(
  electric: ElectricConfig | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<SyncHealth> {
  if (!electric) return { status: 'disabled' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetchFn(new URL(`${electric.url}/v1/health`), {
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 'error', reason: `sync service answered HTTP ${response.status}` };
    }
    const state = await readState(response);
    if (state === 'active') return { status: 'ok' };
    if (state === 'waiting' || state === 'starting') {
      return { status: 'error', reason: `sync service is not replicating yet (${state})` };
    }
    return { status: 'error', reason: 'sync service answered an unexpected state' };
  } catch (error) {
    if (controller.signal.aborted) {
      console.error('sync health check timed out');
      return { status: 'error', reason: 'sync service did not answer within 2 seconds' };
    }
    console.error(
      'sync health check failed:',
      error instanceof Error ? error.name : 'unknown error',
    );
    return { status: 'error', reason: 'sync service is unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function readState(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { status?: unknown };
    return typeof body.status === 'string' ? body.status : undefined;
  } catch {
    return undefined;
  }
}
