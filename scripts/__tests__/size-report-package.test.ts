import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { formatMarkdown } from '../size-report.mjs';
import {
  assertBundledLicenseNotices,
  assertPublishPackageContents,
  parseNpmPackOutput,
} from '../size-report-package.mjs';

const fixturePack = JSON.parse(
  await readFile(join(import.meta.dirname, 'fixtures', 'size-report-npm-pack.json'), 'utf8'),
);

const execFileAsync = promisify(execFile);

// The fixture pack ships the macOS helper (manifest, sources, and per-target PackStub.swift),
// so every assertion here names the manifest source the guard would read from the packed tree;
// without it the guard falls back to this checkout's manifest via repoRoot.
const helperManifestSource = [
  '.target(',
  '  name: "AgentDeviceMacOSInput",',
  '.executableTarget(',
  '  name: "AgentDeviceMacOSHelper",',
  '.testTarget(',
  '  name: "AgentDeviceMacOSHelperTests",',
  '.testTarget(',
  '  name: "AgentDeviceMacOSInputTests",',
].join('\n');

test('publish package requires bundled dependency license notices', () => {
  assert.throws(
    () =>
      assertPublishPackageContents(
        fixturePack.files.filter((entry) => entry.path !== 'dist/src/THIRD_PARTY_NOTICES.txt'),
        { macosHelperManifestSource: helperManifestSource },
      ),
    /THIRD_PARTY_NOTICES\.txt/,
  );
  assert.throws(
    () =>
      assertPublishPackageContents(
        fixturePack.files.map((entry) =>
          entry.path === 'dist/src/THIRD_PARTY_NOTICES.txt' ? { ...entry, size: 0 } : entry,
        ),
        { macosHelperManifestSource: helperManifestSource },
      ),
    /non-empty.*THIRD_PARTY_NOTICES\.txt/,
  );
});

// The publish gate's own copy of what a shipped notices file must contain. Written out rather than
// produced by the bundler: a fixture the producer generates cannot show the producer emitted the wrong
// thing. The attribution lines, the reference markers and the license bodies are the shape
// `renderLicenseNotices` in scripts/size-report-package-notices.mjs writes for a bundled build, and the
// placeholder below is the line that same function writes when the bundle holds no third-party code.
const REAL_NOTICES = [
  '@agent-device/proxy@0.21.37-dev (MIT): [1]',
  'undici@7.1.1 (MIT): [1]',
  '',
  '[1]',
  'Copyright (c) 2023 Callstack',
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
].join('\n');
const EMPTY_BUNDLE_NOTICES = 'No third-party dependencies are bundled.\n';

// Two distinct license bodies, one of them shared by two attributions: the shape the bundler writes
// when it deduplicates identical texts, which the gate must keep accepting.
const TWO_LICENSES_NOTICES = [
  '@agent-device/proxy@0.21.37-dev (MIT): [1]',
  'undici@7.1.1 (MIT): [2]',
  'yauzl@3.4.0 (MIT): [1], [2]',
  '',
  '[1]',
  'Copyright (c) 2023 Callstack',
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
  '',
  '[2]',
  'Copyright (c) 2018 Nathan LaFreniere and other contributors',
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
].join('\n');

/** The pack manifest's notices entry — non-empty by bytes, which is all a manifest can say. */
function noticesEntry() {
  return fixturePack.files.find((entry) => entry.path === 'dist/src/THIRD_PARTY_NOTICES.txt');
}

/**
 * A pack manifest plus the tree it was built from, so the gate is asked about real content and not
 * only about a byte count. `noticesRoot` is the half the placeholder slipped past before.
 */
async function treeWithNotices(contents: string | null): Promise<string> {
  const root = await mkdtempForTest('notices-tree-');
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  if (contents !== null) {
    await writeFile(join(root, 'dist', 'src', 'THIRD_PARTY_NOTICES.txt'), contents);
  }
  return root;
}

test('pack gate rejects the zero-dependency placeholder a non-empty manifest reports', async () => {
  // The failure this exists for: the bundler stops bundling dependencies, the bundler reports none,
  // and the tarball still ships a non-empty notices file. The manifest entry below is exactly the one
  // a healthy build produces, so only the bytes tell the two apart.
  const root = await treeWithNotices(EMPTY_BUNDLE_NOTICES);
  assert.throws(
    () => assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
    /no bundled dependency notices[\s\S]*found 0 attributions and 0 license texts/,
  );
  // Attribution lines with no license text behind them are the same defect by half.
  const halfWritten = await treeWithNotices('@agent-device/proxy@0.21.37-dev (MIT): [1]\n');
  assert.throws(
    () =>
      assertBundledLicenseNotices([noticesEntry()], {
        noticesRoot: halfWritten,
        context: 'npm pack',
      }),
    /found 1 attributions and 0 license texts/,
  );
});

test('pack gate accepts a tree whose notices attribute the bundled dependencies', async () => {
  const root = await treeWithNotices(REAL_NOTICES);
  assert.doesNotThrow(() =>
    assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
  );
});

test('pack gate rejects attributions whose references hold no license text', async () => {
  // A marker is a heading, not a license: this file has the shape the bundler writes and zero terms
  // in it, and a gate that only counts the two kinds of line lets it through.
  const markerWithoutTerms = await treeWithNotices(
    '@agent-device/proxy@0.21.37-dev (MIT): [1]\n\n[1]\n',
  );
  assert.throws(
    () =>
      assertBundledLicenseNotices([noticesEntry()], {
        noticesRoot: markerWithoutTerms,
        context: 'npm pack',
      }),
    /no bundled dependency notices[\s\S]*1 attributions and 0 license texts[\s\S]*unresolved: @agent-device\/proxy@0\.21\.37-dev \(MIT\) -> \[1\]/,
  );
  // The other half: the reference names an id the file never writes.
  const dangling = await treeWithNotices(
    [
      '@agent-device/proxy@0.21.37-dev (MIT): [3]',
      '',
      '[1]',
      'Copyright (c) 2023 Callstack',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
    ].join('\n'),
  );
  assert.throws(
    () =>
      assertBundledLicenseNotices([noticesEntry()], { noticesRoot: dangling, context: 'npm pack' }),
    /unresolved: @agent-device\/proxy@0\.21\.37-dev \(MIT\) -> \[3\]/,
  );
  // An attribution with nothing after the colon promises a license and carries none.
  const noReference = await treeWithNotices(
    [
      '@agent-device/proxy@0.21.37-dev (MIT): ',
      '',
      '[1]',
      'Copyright (c) 2023 Callstack',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
    ].join('\n'),
  );
  assert.throws(
    () =>
      assertBundledLicenseNotices([noticesEntry()], {
        noticesRoot: noReference,
        context: 'npm pack',
      }),
    /unresolved: @agent-device\/proxy@0\.21\.37-dev \(MIT\) -> no reference/,
  );
});

test('pack gate accepts every reference a deduplicated notices file makes', async () => {
  // The bundler numbers each distinct license text once, so one package can point at two texts and
  // two packages can share one. Resolving references must not read that as a missing license.
  const root = await treeWithNotices(TWO_LICENSES_NOTICES);
  assert.doesNotThrow(() =>
    assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
  );
  // The shapes the real build writes and a naive reader would reject: an attribution that names an
  // author after the references, and an Apache-style license whose body carries blank lines.
  await writeFile(
    join(root, 'dist', 'src', 'THIRD_PARTY_NOTICES.txt'),
    [
      '@agent-device/proxy@0.21.37-dev (MIT): [1]; Author: Callstack',
      'undici@7.1.1 (Apache-2.0): [1], [2]; Author: Nathan LaFreniere <other@example.test>',
      '',
      '[1]',
      'Copyright (c) 2023 Callstack',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
      '',
      '[2]',
      'Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file',
      'except in compliance with the License.',
      '',
      'You may obtain a copy of the License at',
      '',
      '    https://www.apache.org/licenses/LICENSE-2.0',
    ].join('\n'),
  );
  assert.doesNotThrow(() =>
    assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
  );
});

test('pack gate names the tree it could not read notices from', async () => {
  const root = await treeWithNotices(null);
  assert.throws(
    () => assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
    /npm pack has no dist\/src\/THIRD_PARTY_NOTICES\.txt/,
  );
});

test('pack gate reads content without a tree, staying a manifest-only check', () => {
  // The manifest entry alone is a presence-and-bytes claim, so that is all this call can prove; the
  // content policy needs the tree whose bytes it is standing in for. Production callers — `collectNpmPack`
  // and both calls in `check-package.ts` — always name that tree, so the packed and installed copies
  // are read, never only the manifest.
  assert.doesNotThrow(() => assertBundledLicenseNotices([noticesEntry()]));
});

/** A dependency the fixture build bundles, with the manifest fields that shape its attribution. */
function dependencyManifest(
  name: string,
  fields: Record<string, string | undefined>,
): [string, string][] {
  return [
    [
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version: '1.2.3', main: 'index.js', ...fields }),
    ],
    [
      `node_modules/${name}/index.js`,
      `export const ${name.replaceAll(/[^A-Za-z0-9_$]/g, '_')} = process.env.${name.toUpperCase()};`,
    ],
    [`node_modules/${name}/LICENSE`, `Copyright ${name} author\nFull ${name} license terms.`],
  ];
}

type FixtureDependency = [string, Record<string, string | undefined>, Record<string, string>?];

/**
 * Real renderer bytes: runs the same `bundledLicenseNotices` plugin the published build uses (through
 * the shared fixture build script) over a fixture tree, so the attribution lines the pack gate reads
 * are the ones `renderLicenseNotices` writes — grouped SPDX field, author clause and all — rather than a
 * hand-written approximation of them. The build writes into the tree's `dist/src`, so the fixture
 * root is the tree the gate reads, whether or not the build succeeded.
 */
async function bundledTree(dependencies: FixtureDependency[]): Promise<string> {
  const root = await realpath(await mkdtempForTest('pack-gate-render-'));
  const files: [string, string][] = [
    ['package.json', JSON.stringify({ name: 'fixture-project', type: 'module' })],
    [
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { target: 'es2022', module: 'nodenext', skipLibCheck: true },
        include: ['input.ts'],
      }),
    ],
    ['input.ts', dependencies.map(([name]) => `export { ${name} } from '${name}';`).join('\n')],
  ];
  for (const [name, fields, extras] of dependencies) {
    files.push(...dependencyManifest(name, fields));
    if (extras) files.push(...Object.entries(extras));
  }
  for (const [relative, source] of files) {
    const file = join(root, relative);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, source);
  }
  return root;
}

async function buildTree(root: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, 'fixtures', 'bundled-license-build.mts'),
      root,
      'false',
      'dist/src',
    ],
    { cwd: import.meta.dirname },
  );
}

async function renderedNotices(dependencies: FixtureDependency[]): Promise<string> {
  const root = await bundledTree(dependencies);
  await buildTree(root);
  return root;
}

test('a licensed dependency cannot carry an unattributable one past build and pack gate', async () => {
  // The former license plugin reported only packages whose manifest named a version or a license, so a
  // bundled `omitted` package with neither left a notices file that attributed its licensed
  // neighbor, and the gate accepted it. The build enumerates bundled modules itself: it fails, writes
  // no notices, and the gate then names the missing file instead of passing a partial one.
  const root = await bundledTree([
    ['included', { license: 'MIT' }],
    ['omitted', { version: undefined }],
  ]);
  await assert.rejects(buildTree(root), /Bundled dependency omitted is missing its version/);
  assert.throws(
    () => assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
    /npm pack has no dist\/src\/THIRD_PARTY_NOTICES\.txt/,
  );
});

test('pack gate accepts the attribution the renderer writes for a grouped SPDX expression', async () => {
  // A `package.json` license may be a grouped SPDX expression, and `renderLicenseNotices` wraps the
  // manifest's license in its own parentheses, so the attribution carries nested ones. Those bytes are
  // valid producer output: the gate has to read them, not report them as naming nobody.
  const root = await renderedNotices([
    ['shared', { license: '(MIT OR Apache-2.0)', author: 'Grouped author <g@example.test>' }],
  ]);
  const rendered = await readFile(join(root, 'dist', 'src', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(rendered, /^shared@1\.2\.3 \(\(MIT OR Apache-2\.0\)\): \[1\]; Author: /m);
  assert.doesNotThrow(() =>
    assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
  );
});

test('pack gate reads the license reference, not the author clause, from real bytes', async () => {
  // The author line is attribution metadata: a bracketed footnote inside it is not a license
  // reference. Resolving it as one would both reject valid bytes (no such section) and let an
  // attribution with no reference at all pass on an author's footnote.
  const root = await renderedNotices([
    ['distinct', { license: 'MIT', author: 'Bracket author [7] <b@example.test>' }],
  ]);
  const rendered = await readFile(join(root, 'dist', 'src', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(rendered, /\[1\]; Author: Bracket author \[7\]/);
  assert.doesNotThrow(() =>
    assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
  );
});

test('pack gate reads no attribution from license or NOTICE body text', async () => {
  // A numbered section holds upstream license or NOTICE text verbatim, at column zero: the renderer
  // neither escapes nor indents it. Prose shaped like an attribution — an email contact, a line
  // pointing at "section [9]" of some other package — is ordinary upstream content, and the only
  // attributions the bundler itself writes are the block before the first heading. Reading a body
  // line as an attribution would reject publishable bytes: the dangling [9] and the empty reference
  // below are unparseable as anything but unresolved attributions.
  const root = await renderedNotices([
    [
      'included',
      { license: 'MIT' },
      {
        'node_modules/included/NOTICE': [
          'This distribution bundles software from several upstreams:',
          'helper-pkg@0.1.0 (MIT): see section [9] for those terms',
          'maintainer@example.test (Apache-2.0): ',
        ].join('\n'),
      },
    ],
  ]);
  const rendered = await readFile(join(root, 'dist', 'src', 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(rendered, /^helper-pkg@0\.1\.0 \(MIT\): see section \[9\]/m);
  assert.doesNotThrow(() =>
    assertBundledLicenseNotices([noticesEntry()], { noticesRoot: root, context: 'npm pack' }),
  );
});

test('pack gate rejects a file that attributes nobody but whose license text names somebody', async () => {
  // The gate exists to catch a notices file that attributes nobody. A build that lost the leading
  // attribution block keeps the heading and bodies, and one body can happen to carry a line shaped
  // like an attribution pointing at its own section. That file must not clear the gate on prose it
  // preserves verbatim: only the block the renderer writes before the first heading attributes.
  const bodyOnly = await treeWithNotices(
    [
      '[1]',
      'Copyright (c) 2023 Callstack',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
      '@agent-device/proxy@0.21.37-dev (MIT): [1]',
    ].join('\n'),
  );
  assert.throws(
    () =>
      assertBundledLicenseNotices([noticesEntry()], {
        noticesRoot: bodyOnly,
        context: 'npm pack',
      }),
    /no bundled dependency notices[\s\S]*found 0 attributions and 1 license texts/,
  );
});

test('pack gate still rejects a grouped attribution whose reference is missing or absent', async () => {
  // The mixed file is the point: a simple attribution must not stand in for the grouped one, so the
  // grouped line has to be inspected and named rather than skipped as unparseable.
  const groupedDangling = await treeWithNotices(
    [
      '@agent-device/proxy@0.21.37-dev (MIT): [1]',
      'undici@7.1.1 (MIT OR (Apache-2.0 AND CC0-1.0)): [9]',
      '',
      '[1]',
      'Copyright (c) 2023 Callstack',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
    ].join('\n'),
  );
  assert.throws(
    () =>
      assertBundledLicenseNotices([noticesEntry()], {
        noticesRoot: groupedDangling,
        context: 'npm pack',
      }),
    /2 attributions and 1 license texts[\s\S]*unresolved: undici@7\.1\.1 \(MIT OR \(Apache-2\.0 AND CC0-1\.0\)\) -> \[9\]/,
  );
  const groupedEmpty = await treeWithNotices(
    [
      '@agent-device/proxy@0.21.37-dev (MIT): [1]',
      'undici@7.1.1 (MIT OR Apache-2.0): ',
      '',
      '[1]',
      'Copyright (c) 2023 Callstack',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
    ].join('\n'),
  );
  assert.throws(
    () =>
      assertBundledLicenseNotices([noticesEntry()], {
        noticesRoot: groupedEmpty,
        context: 'npm pack',
      }),
    /unresolved: undici@7\.1\.1 \(MIT OR Apache-2\.0\) -> no reference/,
  );
});

test('pack gate takes no reference from an author clause', async () => {
  // Written out rather than rendered: the shape the renderer only produces when a package's author
  // field carries a footnote, which the real-bytes case above already covers end to end.
  const authorSupplied = await treeWithNotices(
    [
      '@agent-device/proxy@0.21.37-dev (MIT): ; Author: Footnote author [1]',
      '',
      '[1]',
      'Copyright (c) 2023 Callstack',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
    ].join('\n'),
  );
  assert.throws(
    () =>
      assertBundledLicenseNotices([noticesEntry()], {
        noticesRoot: authorSupplied,
        context: 'npm pack',
      }),
    /unresolved: @agent-device\/proxy@0\.21\.37-dev \(MIT\) -> no reference/,
  );
  // And the same file with a real reference beside the footnote passes: the author clause is
  // ignored, not treated as a rejection by default.
  const withReference = await treeWithNotices(
    [
      '@agent-device/proxy@0.21.37-dev (MIT): [1]; Author: Footnote author [1]',
      '',
      '[1]',
      'Copyright (c) 2023 Callstack',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
    ].join('\n'),
  );
  assert.doesNotThrow(() =>
    assertBundledLicenseNotices([noticesEntry()], {
      noticesRoot: withReference,
      context: 'npm pack',
    }),
  );
});

test('publish package gate rejects placeholder notices from the tree it packed', async () => {
  const root = await treeWithNotices(EMPTY_BUNDLE_NOTICES);
  assert.throws(
    () =>
      assertPublishPackageContents(fixturePack.files, {
        noticesRoot: root,
        macosHelperManifestSource: helperManifestSource,
      }),
    /no bundled dependency notices/,
  );
  await writeFile(join(root, 'dist', 'src', 'THIRD_PARTY_NOTICES.txt'), REAL_NOTICES);
  assert.doesNotThrow(() =>
    assertPublishPackageContents(fixturePack.files, {
      noticesRoot: root,
      macosHelperManifestSource: helperManifestSource,
    }),
  );
});

test('publish package requires both Android helpers and excludes benchmark scripts', () => {
  assert.doesNotThrow(() =>
    assertPublishPackageContents(fixturePack.files, {
      macosHelperManifestSource: helperManifestSource,
    }),
  );
  assert.throws(
    () =>
      assertPublishPackageContents(
        fixturePack.files.filter((entry) => !entry.path.startsWith('android/ime-helper/')),
        { macosHelperManifestSource: helperManifestSource },
      ),
    /android\/ime-helper/,
  );
  assert.throws(
    () =>
      assertPublishPackageContents(
        fixturePack.files.filter(
          (entry) => entry.path !== 'apple/snapshot-bridge/SnapshotBridgeRuntime.m',
        ),
        { requireSnapshotBridge: true },
      ),
    /SnapshotBridgeRuntime\.m/,
  );
  assert.doesNotThrow(() =>
    assertPublishPackageContents(
      fixturePack.files.filter((entry) => !entry.path.startsWith('apple/snapshot-bridge/')),
      { macosHelperManifestSource: helperManifestSource },
    ),
  );
  assert.throws(
    () =>
      assertPublishPackageContents(
        [...fixturePack.files, { path: 'scripts/ios-snapshot-benchmark/run.ts', size: 1 }],
        { macosHelperManifestSource: helperManifestSource },
      ),
    /benchmark or build scripts/,
  );
  // Each declared test target needs its PackStub.swift or the install-time `swift build` of the
  // packed tree dies; a missing one must name the missing path.
  assert.throws(
    () =>
      assertPublishPackageContents(
        fixturePack.files.filter(
          (entry) =>
            entry.path !== 'apple/macos-helper/Tests/AgentDeviceMacOSInputTests/PackStub.swift',
        ),
        { macosHelperManifestSource: helperManifestSource },
      ),
    /pack stubs: apple\/macos-helper\/Tests\/AgentDeviceMacOSInputTests\/PackStub\.swift/,
  );
  assert.throws(
    () =>
      assertPublishPackageContents(
        [
          ...fixturePack.files,
          {
            path: 'apple/macos-helper/Tests/AgentDeviceMacOSInputTests/ScheduleTests.swift',
            size: 1,
          },
        ],
        { macosHelperManifestSource: helperManifestSource },
      ),
    /macOS helper test sources/,
  );
  // A stub path under Tests/ that the declared list does not name is a test source, not an
  // exemption: the old suffix rule let any PackStub.swift through.
  assert.throws(
    () =>
      assertPublishPackageContents(
        [
          ...fixturePack.files,
          {
            path: 'apple/macos-helper/Tests/AgentDeviceSneakyTests/PackStub.swift',
            size: 1,
          },
        ],
        { macosHelperManifestSource: helperManifestSource },
      ),
    /macOS helper test sources: apple\/macos-helper\/Tests\/AgentDeviceSneakyTests\/PackStub\.swift/,
  );
  // The other direction: a declared stub whose target left the manifest is a dead stub riding in
  // the pack on a stale package.json entry, exempt from the path guard, and must be named.
  assert.throws(
    () =>
      assertPublishPackageContents(fixturePack.files, {
        // The manifest now declares only the Input test target; the pack still ships both stubs.
        macosHelperManifestSource: ['.testTarget(', '  name: "AgentDeviceMacOSInputTests",'].join(
          '\n',
        ),
      }),
    /no test target declares: apple\/macos-helper\/Tests\/AgentDeviceMacOSHelperTests\/PackStub\.swift/,
  );
  // Sources without the manifest are not a buildable Swift package; the pack must say so.
  assert.throws(
    () =>
      assertPublishPackageContents(
        fixturePack.files.filter((entry) => entry.path !== 'apple/macos-helper/Package.swift'),
      ),
    /sources without its Package\.swift/,
  );
});

test('Markdown emphasizes total install size and startup without duplicate breakdowns', () => {
  const current = {
    bundled: { rawBytes: 300, gzipBytes: 100 },
    npmPack: {
      tarballBytes: 100,
      unpackedBytes: 300,
      entries: fixturePack.files,
    },
    cleanInstalled: { packageBytes: 300, totalBytes: 350, files: 3 },
    startup: { runs: 7, benchmarks: [{ name: 'CLI --help', medianMs: 20 }] },
  };
  const base = {
    ...current,
    npmPack: { ...current.npmPack, tarballBytes: 90, unpackedBytes: 200 },
    cleanInstalled: { packageBytes: 200, totalBytes: 900, files: 8 },
    startup: { runs: 7, benchmarks: [{ name: 'CLI --help', medianMs: 25 }] },
  };

  const markdown = formatMarkdown(current, base);

  assert.match(markdown, /<!-- agent-device-size-report -->/);
  assert.match(markdown, /\| Installed \(including dependencies\) \| 900 B \| 350 B \| -550 B \|/);
  assert.match(markdown, /\| Package \(unpacked\) \| 200 B \| 300 B \| \+100 B \|/);
  assert.match(markdown, /\| Package \(download\) \| 90 B \| 100 B \| \+10 B \|/);
  assert.match(markdown, /\| CLI --help \| 25.0 ms \| 20.0 ms \| -5.0 ms \|/);
  assert.doesNotMatch(markdown, /JS raw|JS gzip|npm bundled|components|Top.*chunks|packed files/);
  assert.match(
    formatMarkdown(current, null),
    /\| Installed \(including dependencies\) \| - \| 350 B \| - \|/,
  );
});

test('base measurement uses the measured revision package asset policy', async () => {
  const workflow = await readFile(
    join(import.meta.dirname, '../../.github/workflows/size.yml'),
    'utf8',
  );
  const baseStep = workflow
    .split('      - name: Measure base size\n')[1]!
    .split('      - name: Save base dist cache')[0]!;
  assert.match(
    baseStep,
    /git checkout --detach[\s\S]*cp scripts\/size-report-package\*\.mjs \/tmp\/agent-device-size-report\/[\s\S]*node \/tmp\/agent-device-size-report\/size-report\.mjs/,
  );
});

// The size lane copies `scripts/size-report*.mjs` out of the checkout and recopies the measured
// revision's `scripts/size-report-package*.mjs`, then runs the copy with no node_modules. Each
// module the package policy imports must fall in both copies, and the notices format owner, which
// the build also imports, must import nothing.
test('the package policy and its notices format run from the standalone size-report copy', async () => {
  const policy = await readFile(join(import.meta.dirname, '../size-report-package.mjs'), 'utf8');
  const localImports = [...policy.matchAll(/from '\.\/([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(localImports, ['size-report-package-notices.mjs']);
  for (const local of localImports) assert.match(local, /^size-report-package[^/]*\.mjs$/);
  const format = await readFile(
    join(import.meta.dirname, '../size-report-package-notices.mjs'),
    'utf8',
  );
  assert.doesNotMatch(format, /^\s*import\b|\bimport\(|\brequire\(/m);
});

test.each(['1', -1, 0.5, null])('npm pack rejects malformed file sizes (%s)', (size) => {
  assert.throws(
    () =>
      parseNpmPackOutput(
        JSON.stringify([
          {
            filename: 'fixture.tgz',
            size: 1,
            unpackedSize: 1,
            files: [{ path: 'dist/src/THIRD_PARTY_NOTICES.txt', size }],
          },
        ]),
      ),
    /invalid file entry/,
  );
});

test.each(
  ['size', 'unpackedSize'].flatMap((field) =>
    [undefined, null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ field, value })),
  ),
)('npm pack rejects invalid aggregate $field ($value)', ({ field, value }) => {
  assert.throws(
    () =>
      parseNpmPackOutput(
        JSON.stringify({ filename: 'fixture.tgz', ...fixturePack, [field]: value }),
      ),
    new RegExp(`invalid ${field}`),
  );
});

test.each([0, Number.MAX_SAFE_INTEGER])('npm pack retains valid aggregate sizes (%s)', (size) => {
  const parsed = parseNpmPackOutput(
    JSON.stringify({ filename: 'fixture.tgz', ...fixturePack, size, unpackedSize: size }),
  );
  assert.equal(parsed.size, size);
  assert.equal(parsed.unpackedSize, size);
});

test('npm pack parser shares validated file entries across both output shapes', () => {
  const pack = { filename: 'fixture.tgz', ...fixturePack };
  assert.deepEqual(parseNpmPackOutput(JSON.stringify([pack])).files, fixturePack.files);
  assert.deepEqual(parseNpmPackOutput(JSON.stringify(pack)).files, fixturePack.files);
});
