import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

// Check example imports against the documented package entry points.
// The required client example preserves a runnable path through the retained SDK.

const API_DOC_PATHS = [
  'website/docs/docs/client-api.md',
  'website/docs/docs/build-an-integration.md',
] as const;
const EXAMPLES_SDK_DIR = 'examples/sdk';
const PACKAGE_JSON_PATH = 'package.json';

type SubpathManifest = ReadonlyMap<string, ReadonlySet<string>>;

// Symbols the retained SDK examples must exercise.
// Each must be imported by at least one file in examples/sdk/.
const REQUIRED_EXAMPLE_SYMBOLS: readonly { subpath: string; symbol: string }[] = [
  { subpath: 'agent-device', symbol: 'createAgentDeviceClient' },
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

const manifestsByDoc = new Map(
  API_DOC_PATHS.map((docPath) => [docPath, parseSubpathManifest(fs.readFileSync(docPath, 'utf8'))]),
);
const manifest: SubpathManifest = new Map(
  [...manifestsByDoc.values()].flatMap((docManifest) => [...docManifest]),
);
const API_DOCS_LABEL = API_DOC_PATHS.join(' + ');
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

describe('examples/sdk vs Node.js API docs drift guard', () => {
  test('each API doc documents a subpath API manifest to check examples against', () => {
    for (const [docPath, docManifest] of manifestsByDoc) {
      assert.ok(
        docManifest.size > 0,
        `${docPath} did not yield a parseable subpath API manifest; ` +
          'has the "API reference" entry-point list moved or changed format?',
      );
    }
  });

  test('each entry point is documented on exactly one API doc', () => {
    const duplicated = [...manifest.keys()].filter(
      (subpath) =>
        [...manifestsByDoc.values()].filter((docManifest) => docManifest.has(subpath)).length > 1,
    );
    assert.deepEqual(
      duplicated,
      [],
      `Entry point(s) listed on more than one of ${API_DOCS_LABEL}: ${duplicated.join(', ')}`,
    );
  });

  test('the API docs together document every published package entry point', () => {
    assert.deepEqual(
      [...manifest.keys()].sort(),
      packageExports,
      `The union of ${API_DOCS_LABEL} subpath manifests must match ${PACKAGE_JSON_PATH}#exports`,
    );
  });

  test('every symbol an example imports from agent-device is documented in the API docs', () => {
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
      `Example(s) import symbols not listed in the ${API_DOCS_LABEL} subpath API manifests: ` +
        `${undocumented.join(', ')}. Update the owning doc's manifest, or fix the example if this was a typo.`,
    );
  });

  test('the retained client example is still exercised', () => {
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
