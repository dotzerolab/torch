// `pnpm licenses:check`: every production dependency (all workspaces, transitive) must carry an allowed licence.
// A dual licence (`MIT OR GPL-3.0`) passes when one option is allowed; `AND` needs both. Anything else needs an
// entry in config/license-exceptions.json: { "name", "version"?, "reason" }, approved by a maintainer.
// Usage: node scripts/check-licenses.ts [--input <pnpm licenses json>]   (default: runs pnpm licenses list)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type LicenseEntry = { name: string; version: string; license: string };
export type LicenseException = { name: string; version?: string; reason: string };

export const ALLOWED_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
];

/** Evaluates an SPDX expression: OR = any side, AND = both sides, WITH adds an exception to a licence. */
export function isLicenseAllowed(expression: string, allowed: readonly string[]): boolean {
  const allowedIds = new Set(allowed.map((id) => id.toLowerCase()));
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let index = 0;

  const peek = () => tokens[index]?.toUpperCase();
  const parseOr = (): boolean => {
    let result = parseAnd();
    while (peek() === 'OR') {
      index++;
      const right = parseAnd();
      result = result || right;
    }
    return result;
  };
  const parseAnd = (): boolean => {
    let result = parseAtom();
    while (peek() === 'AND') {
      index++;
      const right = parseAtom();
      result = result && right;
    }
    return result;
  };
  const parseAtom = (): boolean => {
    const token = tokens[index++];
    if (token === undefined || token === ')') throw new Error('unexpected end');
    if (token === '(') {
      const inner = parseOr();
      if (tokens[index++] !== ')') throw new Error('missing )');
      return inner;
    }
    if (['AND', 'OR', 'WITH'].includes(token.toUpperCase())) throw new Error('unexpected operator');
    if (peek() === 'WITH') {
      index++;
      if (tokens[index++] === undefined) throw new Error('missing exception id');
    }
    return allowedIds.has(token.replace(/\+$/, '').toLowerCase());
  };

  try {
    const result = parseOr();
    return index === tokens.length ? result : false;
  } catch {
    return false;
  }
}

export function findLicenseViolations(
  entries: LicenseEntry[],
  allowed: readonly string[],
  exceptions: LicenseException[],
): LicenseEntry[] {
  for (const exception of exceptions) {
    if (!exception.reason || exception.reason.trim() === '') {
      throw new Error(`licence exception for "${exception.name}" needs a reason`);
    }
  }
  return entries.filter(
    (entry) =>
      !isLicenseAllowed(entry.license, allowed) &&
      !exceptions.some(
        (e) => e.name === entry.name && (e.version === undefined || e.version === entry.version),
      ),
  );
}

type PnpmLicenses = Record<string, { name: string; versions: string[]; license?: string }[]>;

export function entriesFromPnpm(report: PnpmLicenses): LicenseEntry[] {
  return Object.entries(report).flatMap(([license, packages]) =>
    packages.flatMap((pkg) =>
      pkg.versions.map((version) => ({ name: pkg.name, version, license: pkg.license ?? license })),
    ),
  );
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const flag = process.argv.indexOf('--input');
  let json: string;
  if (flag === -1) {
    const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      console.error(
        `licenses:check could not run "pnpm licenses list": ${result.stderr || result.error}`,
      );
      process.exit(2);
    }
    json = result.stdout;
  } else {
    json = readFileSync(process.argv[flag + 1] ?? '', 'utf8');
  }

  const exceptions = JSON.parse(
    readFileSync(new URL('../config/license-exceptions.json', import.meta.url), 'utf8'),
  ) as LicenseException[];
  const entries = entriesFromPnpm(JSON.parse(json) as PnpmLicenses);
  const violations = findLicenseViolations(entries, ALLOWED_LICENSES, exceptions);

  if (violations.length > 0) {
    console.error(
      `licenses:check failed, ${violations.length} package(s) outside the allowed licences:`,
    );
    for (const v of violations) console.error(`  ${v.name}@${v.version}: ${v.license}`);
    console.error(
      `Allowed: ${ALLOWED_LICENSES.join(', ')}. Exceptions: config/license-exceptions.json`,
    );
    process.exit(1);
  }
  console.info(`licenses:check ok (${entries.length} production packages)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
