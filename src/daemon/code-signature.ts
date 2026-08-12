import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../utils/version.ts';

// `\s*` (not `\s+`) around each optional part: the built daemon entry is a
// minified bundle (tsdown/rolldown `minify: true`), so real import/export
// statements have zero whitespace around `from` and even after the keyword
// itself (e.g. `import{o as e}from"../foo.js"`). `\s+` here would never match
// minified output, silently degrading the whole graph walk to just the entry
// file (see #1545). The `(?![\w$])` boundary after the keyword still rejects
// identifiers like `importantValue` that merely start with "import".
const STATIC_IMPORT_RE =
  /(?:^|[^\w$.])(?:import|export)(?![\w$])\s*(?:type\s+)?(?:[^'"`]*?\s*from\s*)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/gm;
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

export function resolveDaemonCodeSignature(): string {
  const entryPath = process.argv[1];
  if (!entryPath) return 'unknown';
  return computeDaemonCodeSignature(entryPath);
}

export function computeDaemonCodeSignature(
  entryPath: string,
  root: string = findProjectRoot(),
): string {
  try {
    const normalizedRoot = path.resolve(root);
    const normalizedEntryPath = path.resolve(entryPath);
    const queue = [normalizedEntryPath];
    const visited = new Set<string>();
    const fingerprintParts: string[] = [];

    while (queue.length > 0) {
      const currentPath = queue.pop();
      if (!currentPath || visited.has(currentPath)) continue;
      visited.add(currentPath);

      const stat = fs.statSync(currentPath);
      if (!stat.isFile()) continue;

      const relativePath = path.relative(normalizedRoot, currentPath) || currentPath;
      fingerprintParts.push(`${relativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);

      const content = fs.readFileSync(currentPath, 'utf8');
      for (const specifier of collectRelativeImportSpecifiers(content)) {
        const dependencyPath = resolveRelativeImportPath(currentPath, specifier);
        if (dependencyPath) {
          queue.push(dependencyPath);
        }
      }
    }

    const fingerprint = fingerprintParts.sort().join('|');
    const hash = crypto.createHash('sha1').update(fingerprint).digest('hex');
    return `graph:${fingerprintParts.length}:${hash}`;
  } catch {
    return 'unknown';
  }
}

function collectRelativeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  collectImportMatches(content, STATIC_IMPORT_RE, specifiers);
  collectImportMatches(content, DYNAMIC_IMPORT_RE, specifiers);
  return [...specifiers];
}

function collectImportMatches(content: string, pattern: RegExp, specifiers: Set<string>): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(content)) !== null) {
    const specifier = match[1]?.trim();
    if (specifier?.startsWith('.')) {
      specifiers.add(specifier);
    }
  }
}

function resolveRelativeImportPath(fromPath: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(fromPath), specifier);
  const direct = resolveExistingFile(basePath);
  if (direct) return direct;

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const withExtension = resolveExistingFile(`${basePath}${extension}`);
    if (withExtension) return withExtension;
  }

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const indexPath = resolveExistingFile(path.join(basePath, `index${extension}`));
    if (indexPath) return indexPath;
  }

  return null;
}

function resolveExistingFile(candidatePath: string): string | null {
  try {
    return fs.statSync(candidatePath).isFile() ? candidatePath : null;
  } catch {
    return null;
  }
}
