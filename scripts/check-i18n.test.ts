import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-i18n.ts');

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 15_000 });
}

describe('pnpm i18n:check', () => {
  it('exits 0 for the shipped catalogs', () => {
    const result = run();

    expect(result.status).toBe(0);
  });

  it('exits 1 and names the key when a locale has a gap', () => {
    const result = run('--dir', join(here, 'fixtures', 'i18n-gap'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('it');
    expect(result.stderr).toContain('only.in.english');
  });
});
