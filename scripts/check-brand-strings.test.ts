import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findBrandViolations } from './check-brand-strings.ts';

const web = (name: string) => `apps/web/src/${name}`;
const check = (path: string, content: string) => findBrandViolations([{ path, content }]);

describe('findBrandViolations: product name', () => {
  it('flags the name in a string literal', () => {
    expect(check(web('a.ts'), 'const title = "Torch";')).toEqual([
      { path: web('a.ts'), line: 1, reason: 'product-name' },
    ]);
  });

  it('flags the name in a single-quoted string, any case', () => {
    expect(check(web('a.ts'), "const a = 'TORCH';")).toHaveLength(1);
    expect(check(web('a.ts'), "const a = 'the torch app';")).toHaveLength(1);
  });

  it('flags the name in a template literal', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test
    expect(check(web('a.ts'), 'const m = `Hi ${x} Torch`;')).toHaveLength(1);
  });

  it('flags the name in the text of a template literal with several parts', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test
    const source = 'const m = `${a} and Torch and ${b}`;';

    expect(check(web('a.ts'), source)).toHaveLength(1);
  });

  it('flags the name in JSX text', () => {
    expect(check(web('A.tsx'), 'export const A = () => <p>Torch</p>;')).toEqual([
      { path: web('A.tsx'), line: 1, reason: 'product-name' },
    ]);
  });

  it('flags the name in a JSX attribute string', () => {
    expect(check(web('A.tsx'), 'export const A = () => <img alt="Torch" />;')).toHaveLength(1);
  });

  it('flags the name in an i18n catalog value', () => {
    const content = '{\n  "app.welcome": "Welcome to Torch"\n}\n';

    expect(check('packages/shared/src/i18n/en.json', content)).toEqual([
      { path: 'packages/shared/src/i18n/en.json', line: 2, reason: 'product-name' },
    ]);
  });

  it('flags the name in an HTML title', () => {
    expect(check('apps/web/index.html', '<html>\n<title>Torch</title>\n</html>')).toEqual([
      { path: 'apps/web/index.html', line: 2, reason: 'product-name' },
    ]);
  });

  it('reports the line of the match inside a multi-line template literal', () => {
    const source = 'const m = `first\nsecond\nTorch here`;';

    expect(check(web('a.ts'), source)).toEqual([
      { path: web('a.ts'), line: 3, reason: 'product-name' },
    ]);
  });

  it('flags the name written with an escape sequence', () => {
    expect(check(web('a.ts'), 'const a = "To\\u0072ch";')).toHaveLength(1);
  });

  it('allows package imports, dynamic imports and re-exports of @torch/*', () => {
    const source = [
      'import x from "@torch/shared";',
      'import type { Brand } from "@torch/shared/brand";',
      'export { y } from "@torch/shared/i18n";',
      'const z = await import("@torch/shared");',
      'type T = import("@torch/shared").Brand;',
    ].join('\n');

    expect(check(web('a.ts'), source)).toEqual([]);
  });

  it('allows the name inside code identifiers and comments', () => {
    const source = '// Torch is the default brand\nconst torchClient = 1;\nfunction Torch() {}\n';

    expect(check(web('a.ts'), source)).toEqual([]);
  });

  it('does not flag a longer lowercase word that merely starts with it', () => {
    expect(check(web('a.ts'), 'const a = "torchlight";')).toEqual([]);
    expect(check(web('a.ts'), 'const a = "Torchlight";')).toEqual([]);
  });

  it.each(['TorchApp', 'TorchBot/1', 'Torch2', 'Torch_x', 'torchClient', 'TORCHBOT', 'x-Torch-id'])(
    'flags the name inside the compound string "%s"',
    (text) => {
      expect(check(web('a.ts'), `const a = "${text}";`)).toHaveLength(1);
      expect(check('packages/shared/src/i18n/en.json', `{"k": "${text}"}`)).toHaveLength(1);
    },
  );

  it('allows the name where the spec allows it: brand config, docs, README, root community files, package names', () => {
    const name = 'Torch';
    const files = [
      { path: 'config/brand.default.json', content: `{"productName": "${name}"}` },
      { path: 'docs/spec.md', content: `# ${name}` },
      { path: 'README.md', content: `# ${name}` },
      { path: 'NOTICE', content: `${name}\nCopyright 2026 DotZeroLab contributors` },
      { path: 'CONTRIBUTING.md', content: `# Contributing to ${name}` },
      { path: 'SECURITY.md', content: `# ${name} security policy` },
      { path: 'CODE_OF_CONDUCT.md', content: `# ${name} code of conduct` },
      { path: 'package.json', content: `{"name": "@torch/web", "description": "${name}"}` },
      { path: 'docker-compose.dev.yml', content: `name: ${name}` },
    ];

    expect(findBrandViolations(files)).toEqual([]);
  });

  it('does not check test files, which never ship', () => {
    const source = 'expect(brand.productName).toBe("Torch");';

    expect(check('packages/shared/src/brand.test.ts', source)).toEqual([]);
    expect(check('apps/web/src/App.spec.tsx', source)).toEqual([]);
  });

  it('does not check tooling, infra and tests, which no customer sees', () => {
    const name = 'Torch';
    const exempt = [
      'scripts/x.ts',
      'apps/web/e2e/x.spec.ts',
      'apps/web/e2e/fixtures/brand.json',
      '.github/workflows/ci.yml',
      '.env.example',
      'docker-compose.dev.yml',
      'apps/web/vite.config.ts',
      'apps/web/playwright.config.ts',
      'pnpm-lock.yaml',
      'tsconfig.base.json',
      'biome.json',
      'apps/web/README.md',
    ];

    const files = exempt.map((path) => ({ path, content: `const a = "${name}";` }));

    expect(findBrandViolations(files)).toEqual([]);
  });

  it.each([
    ['apps/web/public/manifest.webmanifest', '{"name": "Torch"}'],
    ['apps/web/public/brand/mark.svg', '<svg><text>Torch</text></svg>'],
    ['apps/server/src/emails/welcome.hbs', 'Hello from Torch'],
    ['apps/web/src/theme.css', 'a::after { content: "Torch"; }'],
    ['apps/web/src/locales/en.json', '{"a": "Torch"}'],
    ['packages/shared/src/notes.txt', 'Torch'],
    ['config/other.json', '{"title": "Torch"}'],
    ['apps/web/public/robots.txt', '# Torch'],
  ])('checks every other kind of file too: %s', (path, content) => {
    expect(check(path, content)).toEqual([{ path, line: 1, reason: 'product-name' }]);
  });

  it('checks code files anywhere outside the exempt places', () => {
    expect(check('config/theme.ts', 'export const title = "Torch";')).toHaveLength(1);
    expect(check('apps/server/tools/seed.ts', 'export const title = "Torch";')).toHaveLength(1);
  });
});

describe('pnpm brand:check', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = join(here, 'check-brand-strings.ts');
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function repoWith(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'brand-check-'));
    roots.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const run = (root: string) =>
    spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', timeout: 20_000 });

  it('exits 0 for a clean tree, including files not yet added to git', () => {
    const root = repoWith({ 'apps/web/src/a.ts': 'export const a = 1;' });

    expect(run(root).status).toBe(0);
  });

  it('exits 1 and prints path:line and the reason', () => {
    const root = repoWith({ 'apps/web/src/a.ts': 'export const a = "Torch";\n' });

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/src/a.ts:1 product-name');
  });

  it('ignores files that git ignores', () => {
    const root = repoWith({
      '.gitignore': 'dist/\n',
      'dist/index.html': '<title>Torch</title>',
    });

    expect(run(root).status).toBe(0);
  });
});
