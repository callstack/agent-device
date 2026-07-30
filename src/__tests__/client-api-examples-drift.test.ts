import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

// Guards `examples/sdk/*.ts` against drifting away from the subpath API
// manifest documented in `website/docs/docs/client-api.md` (the "Public
// subpath API exposed for Node consumers" bullet list), in both directions:
//   forward — every symbol an example imports from an `agent-device/...`
//             subpath is one the doc's manifest lists for that subpath, so an
//             example cannot start exercising undocumented API unnoticed.
//   reverse — the handful of symbols the issue calls out as the minimum
//             example surface (createAgentDeviceClient, normalizeBaseUrl,
//             resolveRuntimeTransport, centerOfRect, runBatch) each still
//             appear in some example's imports, so an example cannot be
//             quietly deleted or renamed away from the symbol it exists to
//             demonstrate.
// This mirrors command-doc-coverage.test.ts's markdown-scanning approach
// rather than compiling snippets, since the manifest list is already a
// structured, parseable statement of the subpath surface. The doc's own
// fenced ```ts snippets are compiled separately, in the Node integration lane
// (test/integration/client-api-doc-snippets.test.ts) — that check spawns a
// real tsc Program and doesn't fit the unit suite's wall-clock budget.

const CLIENT_API_DOC_PATH = 'website/docs/docs/client-api.md';
const EXAMPLES_SDK_DIR = 'examples/sdk';
const PACKAGE_JSON_PATH = 'package.json';

type SubpathManifest = ReadonlyMap<string, ReadonlySet<string>>;

// Symbols the acceptance criteria for #1463 requires an example to exercise.
// Each must be imported by at least one file in examples/sdk/.
const REQUIRED_EXAMPLE_SYMBOLS: readonly { subpath: string; symbol: string }[] = [
  { subpath: 'agent-device', symbol: 'createAgentDeviceClient' },
  { subpath: 'agent-device/metro', symbol: 'normalizeBaseUrl' },
  { subpath: 'agent-device/metro', symbol: 'resolveRuntimeTransport' },
  { subpath: 'agent-device/contracts', symbol: 'centerOfRect' },
  { subpath: 'agent-device/batch', symbol: 'runBatch' },
];

// Parses the "API reference" bullet list: a top-level `- \`agent-device...\``
// bullet starts a subpath section; backtick-quoted identifiers on its nested
// bullet lines (stripping a trailing `(...)` call signature) are that
// subpath's documented symbols, until the next top-level bullet.
function matchTopLevelSubpathBullet(line: string): string | null {
  return /^- `(agent-device[a-z0-9/-]*)`$/.exec(line)?.[1] ?? null;
}

function extractBacktickedNames(line: string): string[] {
  return [...line.matchAll(/`([A-Za-z0-9_]+)(?:\([^)]*\))?`/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function parseSubpathManifest(markdown: string): SubpathManifest {
  const manifest = new Map<string, Set<string>>();
  let currentSubpath: string | null = null;
  for (const line of markdown.split('\n')) {
    const subpath = matchTopLevelSubpathBullet(line);
    if (subpath) {
      currentSubpath = subpath;
      if (!manifest.has(subpath)) manifest.set(subpath, new Set());
      continue;
    }
    if (!currentSubpath || !/^\s+- /.test(line)) continue;
    const symbols = manifest.get(currentSubpath);
    if (!symbols) continue;
    for (const name of extractBacktickedNames(line)) symbols.add(name);
  }
  return manifest;
}

// Extracts `import { a, b } from 'agent-device...'` / `import type {...}`
// bindings per subpath from a single example file.
function extractImportedSymbols(source: string): Map<string, Set<string>> {
  const bySubpath = new Map<string, Set<string>>();
  const importPattern = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'(agent-device[^']*)'/g;
  for (const match of source.matchAll(importPattern)) {
    const [, bindings, subpath] = match;
    if (!bindings || !subpath) continue;
    const symbols = bySubpath.get(subpath) ?? new Set<string>();
    bySubpath.set(subpath, symbols);
    for (const binding of bindings.split(',')) {
      const name = binding
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) symbols.add(name);
    }
  }
  return bySubpath;
}

function listExampleFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()
    .map((entry) => path.join(dir, entry));
}

const manifest = parseSubpathManifest(fs.readFileSync(CLIENT_API_DOC_PATH, 'utf8'));
const exampleFiles = listExampleFiles(EXAMPLES_SDK_DIR);
const packageExports = Object.keys(
  (JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { exports?: Record<string, unknown> })
    .exports ?? {},
)
  .map((subpath) => (subpath === '.' ? 'agent-device' : `agent-device${subpath.slice(1)}`))
  .sort();
const importsByFile = new Map(
  exampleFiles.map((file) => [file, extractImportedSymbols(fs.readFileSync(file, 'utf8'))]),
);

describe('examples/sdk vs client-api.md drift guard', () => {
  test('client-api.md documents a subpath API manifest to check examples against', () => {
    assert.ok(
      manifest.size > 0,
      `${CLIENT_API_DOC_PATH} did not yield a parseable subpath API manifest; ` +
        'has the "API reference" entry-point list moved or changed format?',
    );
  });

  test('client-api.md documents every published package entry point', () => {
    assert.deepEqual(
      [...manifest.keys()].sort(),
      packageExports,
      `${CLIENT_API_DOC_PATH}'s public subpath manifest must match ${PACKAGE_JSON_PATH}#exports`,
    );
  });

  test('every symbol an example imports from agent-device is documented in client-api.md', () => {
    const undocumented: string[] = [];
    for (const [file, importsBySubpath] of importsByFile) {
      for (const [subpath, symbols] of importsBySubpath) {
        const documented = manifest.get(subpath);
        for (const symbol of symbols) {
          if (!documented || !documented.has(symbol)) {
            undocumented.push(`${file}: \`${symbol}\` from \`${subpath}\``);
          }
        }
      }
    }
    assert.deepEqual(
      undocumented,
      [],
      `Example(s) import symbols not listed in ${CLIENT_API_DOC_PATH}'s subpath API manifest: ` +
        `${undocumented.join(', ')}. Update the doc's manifest, or fix the example if this was a typo.`,
    );
  });

  test('the minimum example surface required by #1463 is still exercised', () => {
    const missing = REQUIRED_EXAMPLE_SYMBOLS.filter(
      ({ subpath, symbol }) =>
        ![...importsByFile.values()].some((importsBySubpath) =>
          importsBySubpath.get(subpath)?.has(symbol),
        ),
    ).map(({ subpath, symbol }) => `\`${symbol}\` from \`${subpath}\``);
    assert.deepEqual(
      missing,
      [],
      `No example in ${EXAMPLES_SDK_DIR} imports: ${missing.join(', ')}. ` +
        'Restore the example that demonstrates it, or update this test if the ' +
        'requirement in issue #1463 has intentionally changed.',
    );
  });
});
