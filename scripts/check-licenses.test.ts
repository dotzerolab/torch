import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLicenseViolations, isLicenseAllowed } from './check-licenses.ts';

const ALLOWED = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC'];

describe('isLicenseAllowed', () => {
  it.each([
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'ISC',
    'mit',
    'MIT OR GPL-3.0',
    '(MIT OR Apache-2.0)',
    '(Apache-2.0 OR GPL-2.0) AND MIT',
    'Apache-2.0 WITH LLVM-exception',
  ])('allows %s', (license) => {
    expect(isLicenseAllowed(license, ALLOWED)).toBe(true);
  });

  it.each([
    'GPL-3.0',
    'GPL-3.0-only',
    'AGPL-3.0-or-later',
    'MPL-2.0',
    'UNLICENSED',
    'UNKNOWN',
    'SEE LICENSE IN LICENSE.txt',
    'MIT AND GPL-3.0',
    'GPL-3.0 WITH Classpath-exception-2.0',
    'MIT OR',
    '(MIT',
    '',
  ])('rejects %s', (license) => {
    expect(isLicenseAllowed(license, ALLOWED)).toBe(false);
  });
});

describe('findLicenseViolations', () => {
  const entries = [
    { name: 'fine', version: '1.0.0', license: 'MIT' },
    { name: 'copyleft', version: '2.0.0', license: 'GPL-3.0' },
  ];

  it('lists the packages whose licence is not allowed', () => {
    expect(findLicenseViolations(entries, ALLOWED, [])).toEqual([
      { name: 'copyleft', version: '2.0.0', license: 'GPL-3.0' },
    ]);
  });

  it('passes a package that has an exception with a reason', () => {
    const exceptions = [{ name: 'copyleft', reason: 'build-time only, approved by a maintainer' }];

    expect(findLicenseViolations(entries, ALLOWED, exceptions)).toEqual([]);
  });

  it('an exception pinned to another version does not cover this one', () => {
    const exceptions = [{ name: 'copyleft', version: '1.0.0', reason: 'old version only' }];

    expect(findLicenseViolations(entries, ALLOWED, exceptions)).toHaveLength(1);
  });

  it('rejects an exception without a reason', () => {
    expect(() =>
      findLicenseViolations(entries, ALLOWED, [{ name: 'copyleft', reason: ' ' }]),
    ).toThrow(/reason/);
  });
});

describe('pnpm licenses:check', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = join(here, 'check-licenses.ts');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });

  it('exits 1 and names a fixture dependency licensed GPL-3.0', () => {
    const result = run('--input', join(here, 'fixtures', 'licenses-gpl.json'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('copyleft-fixture@2.1.0');
    expect(result.stderr).toContain('GPL-3.0');
    expect(result.stderr).not.toContain('left-pad-fixture');
  });

  it('exits 0 on the real dependency tree', () => {
    const result = run();

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
