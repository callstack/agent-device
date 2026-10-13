// Daemon residue scan (11a-4): every module specifier in a file under src/daemon/ that resolves
// to a non-package module outside src/daemon/. The rule: daemon files may import workspace
// packages, externals, and each other — nothing else. Once the daemon is its own package, R11 in
// the layering guard (#3546) enforces this permanently; until then this scan is the measurement.
//
// Why a naive regex reported zero edges while five mocks survived: a single alternation that
// starts at `import|export` and bridges to the next `from` with `[\s\S]*?` swallows everything in
// between — including a `vi.mock('../../../platform-runtime-….ts', …)` whose own specifier sits
// between an earlier `importOriginal<typeof import(...)>` and the file's next static `from`. The
// mocked specifier is then attributed to the wrong (allowed) capture or skipped entirely. So each
// specifier form is matched independently, statement-anchored where the language is:
//
//   - static `import`/`export … from '…'` and side-effect `import '…'`, anchored at a statement
//     start (line start or `;`), never bridging statements;
//   - `import type` / `export type` variants (same anchor);
//   - dynamic `import('…')` / `require('…')` with a string or no-substitution template argument;
//   - `vi.mock` / `vi.doMock` / `vi.unmock` / `vi.importMock` / `vi.importActual` /
//     `vi.importOriginal` first argument, any position, string or template literal;
//   - `importOriginal<typeof import('…')>` type-position specifiers (the dynamic-import form).
//
// Known limits: computed specifiers (variables, string concatenation) are out of scope — none
// exist in the daemon tree, and a runtime resolver is the only tool that could see them.
//
// Usage: `node scripts/daemon-edge-residue-scan.mjs` from the repo root. Exit code 1 when any
// edge is found.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(ent.name)) out.push(p);
  }
  return out;
}

// A quoted string or no-substitution template literal as the specifier position.
const SPEC = '(?:\'([^\']*)\'|"([^"]*)"|`([^`]*)`)';
const forms = [
  // Static import/export with a `from` clause; the keyword must start a statement.
  new RegExp(`(?:^|[;\\n])\\s*(?:import|export)\\b[^'"()\`]*?\\bfrom\\s*${SPEC}`, 'gm'),
  // Side-effect import.
  new RegExp(`(?:^|[;\\n])\\s*import\\s+${SPEC}`, 'gm'),
  // Dynamic import (also catches `typeof import('…')` in type positions) and require.
  new RegExp(`\\bimport\\s*\\(\\s*${SPEC}`, 'g'),
  new RegExp(`\\brequire\\s*\\(\\s*${SPEC}`, 'g'),
  // Vitest module-factory hoists, any position in the file.
  new RegExp(
    `\\bvi\\.(?:mock|doMock|unmock|importMock|importActual|importOriginal)\\s*\\(\\s*${SPEC}`,
    'g',
  ),
];

const files = walk(path.join(root, 'src/daemon'), []);
const edges = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const source = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const form of forms) {
    form.lastIndex = 0;
    let match;
    while ((match = form.exec(source))) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (!specifier.startsWith('.')) continue; // bare specifier: package or external, allowed
      const resolved = path
        .normalize(path.join(path.dirname(rel), specifier))
        .replace(/\.tsx?$/, '');
      // path.join yields backslashes on Windows, so compare against the native separator.
      const daemonDir = path.join('src', 'daemon');
      if (resolved === daemonDir || resolved.startsWith(`${daemonDir}${path.sep}`)) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      // The static forms anchor at the preceding `;`/newline, so slice(0, match.index)
      // counts lines only up to that separator and reports one early. Count to the
      // keyword inside the match (position 0 for the unanchored forms).
      const keywordAt = match[0].search(/import|export|require|vi\./);
      const line = source.slice(0, match.index + keywordAt).split('\n').length;
      edges.push(`${rel}:${line} -> ${resolved}`);
    }
  }
}
edges.sort();
if (edges.length > 0) process.stdout.write(edges.join('\n') + '\n');
process.stdout.write(`daemon residue edges: ${edges.length}\n`);
if (edges.length > 0) process.exit(1);
