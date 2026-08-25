import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { computeDaemonCodeSignature } from '../code-signature.ts';
import { resolveCachedDaemonCodeSignature } from '../code-signature-cache.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A source-checkout graph: an entry, a dependency it imports, and a file
 * outside the graph. Sizes differ per revision on purpose — the fingerprint
 * buckets on `size:mtime`, not content (see the sibling walk tests), so a
 * same-length rewrite can land in the same bucket on a fast filesystem.
 *
 * `dependency` names how the entry imports that file: extension-full by
 * default, so that resolution has exactly one candidate, and extensionless for
 * the tests about which candidate wins.
 *
 * The cache's temporary directory is redirected inside the fixture, so the
 * documents a test sees are exactly the ones its own fixture published — never
 * a document a parallel worker owns in the run's shared `TMPDIR`.
 */
function writeGraphFixture(
  prefix: string,
  dependency: { specifier: string; fileName: string } = {
    specifier: './dep.ts',
    fileName: 'dep.ts',
  },
): {
  root: string;
  entryPath: string;
  depPath: string;
  cacheHome: string;
} {
  const root = mkdtempForTestSync(prefix);
  const entryPath = path.join(root, 'src', 'daemon.ts');
  const depPath = path.join(root, 'src', dependency.fileName);
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, `import '${dependency.specifier}';\n`, 'utf8');
  fs.writeFileSync(depPath, 'export const dep = 1;\n', 'utf8');
  const cacheHome = path.join(root, 'cache-home');
  fs.mkdirSync(cacheHome, { recursive: true });
  vi.spyOn(os, 'tmpdir').mockReturnValue(cacheHome);
  return { root, entryPath, depPath, cacheHome };
}

/** Every document this fixture published, whatever key each landed on. */
function listCacheDocuments(cacheHome: string): string[] {
  return fs
    .readdirSync(cacheHome)
    .flatMap((name) =>
      fs.readdirSync(path.join(cacheHome, name)).map((doc) => path.join(cacheHome, name, doc)),
    );
}

function writeDocuments(documents: readonly string[], contents: string): void {
  assert.ok(documents.length > 0);
  for (const document of documents) {
    fs.writeFileSync(document, contents, 'utf8');
  }
}

/** Spies on reads while calling through, so the walk still works if it happens. */
function spyOnReads(): () => string[] {
  const readSpy = vi.spyOn(fs, 'readFileSync');
  return () =>
    readSpy.mock.calls
      .map(([target]) => target)
      .filter((target): target is string => typeof target === 'string');
}

test('resolveCachedDaemonCodeSignature returns the uncached signature and stops reading sources once warm', () => {
  const { root, entryPath } = writeGraphFixture('agent-device-signature-cache-warm-');
  try {
    const expected = computeDaemonCodeSignature(entryPath, root);

    assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), expected);

    const readPaths = spyOnReads();
    assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), expected);
    assert.deepEqual(
      readPaths().filter((target) => target.startsWith(root)),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature re-walks when a graph file changes', () => {
  const { root, entryPath, depPath } = writeGraphFixture('agent-device-signature-cache-change-');
  try {
    const initial = resolveCachedDaemonCodeSignature(entryPath, root);

    fs.writeFileSync(depPath, 'export const dep = 20000;\n', 'utf8');
    const changed = resolveCachedDaemonCodeSignature(entryPath, root);

    assert.notEqual(changed, initial);
    assert.equal(changed, computeDaemonCodeSignature(entryPath, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature discovers an import edge added after the cache was written', () => {
  const { root, entryPath, depPath } = writeGraphFixture('agent-device-signature-cache-edge-');
  try {
    const initial = resolveCachedDaemonCodeSignature(entryPath, root);
    assert.match(initial, /^graph:2:/);

    fs.writeFileSync(path.join(root, 'src', 'added.ts'), 'export const added = 1;\n', 'utf8');
    fs.writeFileSync(depPath, "import './added.ts';\nexport const dep = 1;\n", 'utf8');

    const grown = resolveCachedDaemonCodeSignature(entryPath, root);
    assert.match(grown, /^graph:3:/);
    assert.equal(grown, computeDaemonCodeSignature(entryPath, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature re-walks when a higher-precedence extension appears', () => {
  const { root, entryPath } = writeGraphFixture('agent-device-signature-cache-precedence-', {
    specifier: './dep',
    fileName: 'dep.js',
  });
  try {
    const initial = resolveCachedDaemonCodeSignature(entryPath, root);
    assert.equal(initial, computeDaemonCodeSignature(entryPath, root));

    // Resolution probes `.ts` before `.js`, so `./dep` now means this file and
    // `dep.js` has left the graph — while every file the cache recorded still
    // stamps identically. A cache that only revalidates recorded stamps hands
    // back a signature the daemon this client would reuse never reports.
    fs.writeFileSync(path.join(root, 'src', 'dep.ts'), 'export const dep = 20000;\n', 'utf8');

    const fresh = computeDaemonCodeSignature(entryPath, root);
    assert.notEqual(fresh, initial);
    assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), fresh);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature stays warm when a lower-precedence extension appears', () => {
  const { root, entryPath } = writeGraphFixture('agent-device-signature-cache-behind-', {
    specifier: './dep',
    fileName: 'dep.ts',
  });
  try {
    const expected = resolveCachedDaemonCodeSignature(entryPath, root);

    // `.ts` already won, so resolution never probes this far and the graph is
    // unchanged. Recording candidates BEHIND the winner would spend the whole
    // point of the cache re-walking edits that cannot move an edge.
    fs.writeFileSync(path.join(root, 'src', 'dep.js'), 'export const dep = 20000;\n', 'utf8');

    // Uncached first, so the walk this comparison needs is not itself counted
    // as a read the cached call made.
    assert.equal(computeDaemonCodeSignature(entryPath, root), expected);

    const readPaths = spyOnReads();
    assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), expected);
    assert.deepEqual(
      readPaths().filter((target) => target.startsWith(root)),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature re-walks when a specifier that resolved to nothing gains a target', () => {
  const { root, entryPath } = writeGraphFixture('agent-device-signature-cache-appears-');
  try {
    fs.appendFileSync(entryPath, "import './later';\n", 'utf8');
    const initial = resolveCachedDaemonCodeSignature(entryPath, root);
    assert.match(initial, /^graph:2:/);

    // The entry is not rewritten to add this edge: the edge was always there,
    // and only its target was missing when the document was published.
    fs.writeFileSync(path.join(root, 'src', 'later.ts'), 'export const later = 1;\n', 'utf8');

    const grown = resolveCachedDaemonCodeSignature(entryPath, root);
    assert.match(grown, /^graph:3:/);
    assert.equal(grown, computeDaemonCodeSignature(entryPath, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature re-walks when a cached graph file is deleted', () => {
  const { root, entryPath, depPath } = writeGraphFixture('agent-device-signature-cache-delete-');
  try {
    const initial = resolveCachedDaemonCodeSignature(entryPath, root);
    assert.match(initial, /^graph:2:/);

    // Only the dependency goes: the unchanged entry still stamps identically,
    // so the vanished file is the sole invalidation signal.
    fs.rmSync(depPath);

    const shrunk = resolveCachedDaemonCodeSignature(entryPath, root);
    assert.match(shrunk, /^graph:1:/);
    assert.equal(shrunk, computeDaemonCodeSignature(entryPath, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The cache is a best-effort artifact in a shared temporary directory:
// truncated, half-written, or foreign content must never surface as a
// signature, because a wrong signature restarts a healthy daemon on every
// invocation.
const UNUSABLE_CACHE_DOCUMENTS = [
  '{"version":2,"files":[["src/dep.ts",12,34]],"absent":[]',
  '{"version":2,"files":[["src/dep.ts"]],"absent":[]}',
  '{"version":2,"files":[["src/daemon.ts",1,2]]}',
  '{"version":2,"files":[["src/daemon.ts",1,2]],"absent":[7]}',
  '{"version":99,"files":[],"absent":[]}',
  '{"version":2,"files":[],"absent":[]}',
  'null',
];

for (const document of UNUSABLE_CACHE_DOCUMENTS) {
  test(`resolveCachedDaemonCodeSignature falls back to the walk for cache document ${document}`, () => {
    const { root, entryPath, cacheHome } = writeGraphFixture(
      'agent-device-signature-cache-corrupt-',
    );
    try {
      const expected = resolveCachedDaemonCodeSignature(entryPath, root);
      writeDocuments(listCacheDocuments(cacheHome), document);

      assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('resolveCachedDaemonCodeSignature republishes over a zero-entry document instead of restarting the daemon forever', () => {
  const { root, entryPath, cacheHome } = writeGraphFixture('agent-device-signature-cache-empty-');
  const emptyDocument = '{"version":2,"files":[],"absent":[]}';
  try {
    const expected = resolveCachedDaemonCodeSignature(entryPath, root);
    const documents = listCacheDocuments(cacheHome);
    // Every stamp in an empty list matches vacuously, so a document that
    // merely fell back to the walk without republishing would be re-read and
    // re-refused on every invocation: a permanent daemon-restart loop.
    writeDocuments(documents, emptyDocument);

    assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), expected);
    for (const document of documents) {
      assert.notEqual(fs.readFileSync(document, 'utf8'), emptyDocument);
    }

    const readPaths = spyOnReads();
    assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), expected);
    assert.deepEqual(
      readPaths().filter((target) => target.startsWith(root)),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature refuses a document that omits the entry itself', () => {
  const { root, entryPath, cacheHome } = writeGraphFixture('agent-device-signature-cache-subset-');
  try {
    const expected = resolveCachedDaemonCodeSignature(entryPath, root);
    const documents = listCacheDocuments(cacheHome);
    // Every surviving stamp still matches disk, so a subset of the real graph
    // would validate — and answer with a signature no daemon ever reports.
    for (const document of documents) {
      const parsed = JSON.parse(fs.readFileSync(document, 'utf8')) as {
        files: [string, number, number][];
        absent: string[];
      };
      const files = parsed.files.filter(([label]) => label !== path.join('src', 'daemon.ts'));
      assert.equal(files.length, parsed.files.length - 1);
      fs.writeFileSync(document, JSON.stringify({ ...parsed, files }), 'utf8');
    }

    assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature ignores a cache document another user wrote', () => {
  const { root, entryPath } = writeGraphFixture('agent-device-signature-cache-foreign-');
  try {
    const expected = resolveCachedDaemonCodeSignature(entryPath, root);

    // On Linux the cache directory lives in the shared `/tmp`: a document this
    // user did not write must not choose the signature the client compares a
    // running daemon against.
    const foreignStats = fs.statSync(entryPath);
    foreignStats.uid += 1;
    vi.spyOn(fs, 'fstatSync').mockReturnValue(foreignStats);

    const readPaths = spyOnReads();
    assert.equal(resolveCachedDaemonCodeSignature(entryPath, root), expected);
    assert.ok(readPaths().includes(entryPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCachedDaemonCodeSignature reports an unreadable entry as unknown', () => {
  const root = mkdtempForTestSync('agent-device-signature-cache-missing-');
  try {
    assert.equal(
      resolveCachedDaemonCodeSignature(path.join(root, 'src', 'daemon.ts'), root),
      'unknown',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
