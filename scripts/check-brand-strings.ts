// `pnpm brand:check`: the white-label rule from design section 13 (docs/design.md).
//   product-name   the product name appears in a file that can reach a customer. Every tracked text file is
//                  checked, except the exempt places below (docs, README, package.json, the default brand config,
//                  tests, scripts, CI and dev infra, tool configs). In code files only string literals, template
//                  literals and JSX text count: identifiers, `@torch/*` package names and comments are fine. In
//                  every other file (JSON, HTML, CSS, SVG, templates, manifests, text) any occurrence counts.
//                  A compound such as TorchBot, Torch2 or torch_id counts; a longer lowercase word (torchlight) not.
// Usage: node scripts/check-brand-strings.ts [--root <dir>]   (default: the repo root; checks git's file list)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type BrandViolation = {
  path: string;
  line: number;
  reason: 'product-name';
};
export type SourceFileInput = { path: string; content: string };

// The whole word in any case, a capitalised or lowercase-led compound (TorchBot, Torch2, torchClient, torch_id),
// or an all-caps one (TORCHBOT). Not a longer lowercase word such as "torchlight".
const PRODUCT_NAME_SOURCE = String.raw`\b[Tt][Oo][Rr][Cc][Hh]\b|[Tt]orch(?![a-z])|TORCH`;
const PRODUCT_NAME = new RegExp(PRODUCT_NAME_SOURCE);
const PRODUCT_NAME_GLOBAL = new RegExp(PRODUCT_NAME_SOURCE, 'g');
const PACKAGE_REF = /@torch\/[\w./-]*/gi;

const isTestFile = (path: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
const isCode = (path: string) => /\.[cm]?[jt]sx?$/.test(path);

// Places the product name may appear because no customer sees them (design section 13).
const EXEMPT_PATHS: RegExp[] = [
  /^docs\//,
  /(?:^|\/)README\.md$/,
  /^(?:LICENSE|NOTICE|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md)$/, // open-source files of the repo root
  /^config\/brand\.default\.json$/, // the default brand names the product
  /(?:^|\/)package\.json$/, // package names (@torch/*)
  /^pnpm-(?:lock|workspace)\.yaml$/,
  /^scripts\//, // the gates themselves and their fixtures
  /(?:^|\/)e2e\//, // browser tests and their fixtures
  /^\.(?:github|githooks)\//,
  /^\.(?:gitignore|gitleaks\.toml|nvmrc|env\.example)$/,
  /^docker-compose[^/]*\.ya?ml$/,
  /^(?:biome|tsconfig[^/]*)\.json$/,
  /(?:^|\/)(?:vite|vitest|playwright)\.config\.ts$/,
];
const isExempt = (path: string) => isTestFile(path) || EXEMPT_PATHS.some((re) => re.test(path));

export function findBrandViolations(files: SourceFileInput[]): BrandViolation[] {
  const violations: BrandViolation[] = [];
  for (const { path, content } of files) {
    const add = (line: number, reason: BrandViolation['reason']) => {
      if (!violations.some((v) => v.path === path && v.line === line && v.reason === reason)) {
        violations.push({ path, line, reason });
      }
    };

    if (!isExempt(path)) {
      const lines = isCode(path)
        ? productNameLinesInCode(path, content)
        : productNameLinesInText(content);
      for (const line of lines) add(line, 'product-name');
    }
  }
  return violations;
}

// Same-length blanking keeps match offsets valid for line numbers.
const withoutPackageRefs = (text: string) => text.replace(PACKAGE_REF, (m) => ' '.repeat(m.length));

function productNameLinesInText(content: string): number[] {
  const lines: number[] = [];
  content.split('\n').forEach((text, index) => {
    if (PRODUCT_NAME.test(withoutPackageRefs(text))) lines.push(index + 1);
  });
  return lines;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.[jt]sx$/.test(path)) return ts.ScriptKind.TSX;
  return /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function productNameLinesInCode(path: string, content: string): number[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  const lines = new Set<number>();

  const lineAt = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
  const inspect = (node: ts.Node, cooked: string) => {
    if (!PRODUCT_NAME.test(withoutPackageRefs(cooked))) return;
    // Lines come from the raw source text; an escaped spelling ("Torch") only matches the cooked text.
    const raw = withoutPackageRefs(source.text.slice(node.pos, node.end));
    const matches = [...raw.matchAll(PRODUCT_NAME_GLOBAL)];
    if (matches.length === 0) lines.add(lineAt(node.getStart(source)));
    for (const match of matches) lines.add(lineAt(node.pos + match.index));
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node)) {
      if (!isModuleReference(node)) inspect(node, node.text);
    } else if (ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      inspect(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...lines].sort((a, b) => a - b);
}

// `import x from "..."`, `export ... from "..."`, `import("...")`, `require("...")`, `import("...").T`
function isModuleReference(node: ts.StringLiteral): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isExternalModuleReference(parent) || ts.isModuleDeclaration(parent)) return true;
  if (ts.isCallExpression(parent)) {
    return (
      parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')
    );
  }
  return ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent);
}

function readTextFiles(root: string): SourceFileInput[] {
  const listing = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const files: SourceFileInput[] = [];
  for (const path of listing.split('\0').filter(Boolean)) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(root, path));
    } catch {
      continue; // listed by git but deleted from the working tree
    }
    if (buffer.subarray(0, 8000).includes(0)) continue; // binary
    files.push({ path, content: buffer.toString('utf8') });
  }
  return files;
}

function main() {
  const flag = process.argv.indexOf('--root');
  const root =
    flag === -1
      ? fileURLToPath(new URL('..', import.meta.url))
      : (process.argv[flag + 1] ?? process.cwd());
  const violations = findBrandViolations(readTextFiles(root));
  if (violations.length > 0) {
    console.error(`brand:check failed, ${violations.length} violation(s):`);
    for (const { path, line, reason } of violations) console.error(`  ${path}:${line} ${reason}`);
    process.exit(1);
  }
  console.info('brand:check ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
