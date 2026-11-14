// Electric connection settings from the environment. Off (undefined) without ELECTRIC_URL; a half-set or malformed
// configuration stops the server at startup instead of failing on the first sync request.
export type ElectricConfig = { url: string; secret: string };

export class ElectricConfigError extends Error {}

/** The messages name variables only: the secret's value is never part of an error or a log line. */
export function readElectricConfig(
  env: Record<string, string | undefined>,
): ElectricConfig | undefined {
  const rawUrl = env.ELECTRIC_URL;
  if (!rawUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ElectricConfigError(
      'ELECTRIC_URL must be an http(s) URL such as http://localhost:3010',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ElectricConfigError(
      'ELECTRIC_URL must be an http(s) URL such as http://localhost:3010',
    );
  }
  if (!env.ELECTRIC_SECRET) {
    throw new ElectricConfigError('ELECTRIC_SECRET must be set when ELECTRIC_URL is set');
  }
  return { url: rawUrl.replace(/\/+$/, ''), secret: env.ELECTRIC_SECRET };
}
