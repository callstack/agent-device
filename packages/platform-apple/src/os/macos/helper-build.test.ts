import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

// Getting to the macOS helper binary means answering two host facts first: where the Swift package
// sits relative to this module, and under which home the install directory lives. A Linux coverage
// runner cannot answer either the way a macOS checkout does, so those two lookups are declared
// here while the source-tree walk, the fingerprint, the build, the install, and the manifest round
// trip all run for real against a scratch tree. Only the Swift toolchain itself is doubled, at the
// seam `helper.ts` consumes it, because what is under test is which files the freshness decision
// reads — not what the compiler prints.
const layout = vi.hoisted(() => ({
  home: '',
  repoRoot: '',
  packageRoot: '',
  swiftBuildCalls: [] as string[],
  helperCommands: [] as string[],
}));

vi.mock('node:url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:url')>();
  return {
    ...actual,
    fileURLToPath: (url: Parameters<typeof actual.fileURLToPath>[0]) => {
      const href = (typeof url === 'string' ? url : url.href).replace(/\?.*$/, '');
      if (/\/os\/macos\/helper\.(?:ts|js)$/.test(href)) {
        // A packaged copy of the module below the repo root, which is how the published layout
        // sits relative to `apple/macos-helper`.
        return `${layout.repoRoot}/dist/packages/platform-apple/src/os/macos/helper.js`;
      }
      return actual.fileURLToPath(url);
    },
  };
});

vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/host-file')>();
  return { ...actual, hostHomeDirectory: () => layout.home };
});

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  // The helper is a macOS-only build and the lane that scores this file runs on Linux.
  return { ...actual, hostPlatform: () => 'darwin' };
});

vi.mock('../../core/tool-provider.ts', async (importOriginal) => {
  const { default: fsPromises } = await import('node:fs/promises');
  const { default: pathLib } = await import('node:path');
  const actual = await importOriginal<typeof import('../../core/tool-provider.ts')>();
  return {
    ...actual,
    runAppleToolCommand: async (cmd: string, args: string[]) => {
      if (cmd === 'swift' && args[0] === '--version') {
        return {
          exitCode: 0,
          stdout: 'Swift version 6.2 (swiftlang-6.2.0.192.12), target: arm64-apple-darwin\n',
          stderr: '',
        };
      }
      if (cmd === 'swift' && args[0] === 'build') {
        layout.swiftBuildCalls.push([cmd, ...args].join(' '));
        // A release build leaves its product exactly where the install step expects to find it.
        const binaryPath = pathLib.join(
          layout.packageRoot,
          '.build',
          'release',
          'agent-device-macos-helper',
        );
        await fsPromises.mkdir(pathLib.dirname(binaryPath), { recursive: true });
        await fsPromises.writeFile(
          binaryPath,
          `// helper build ${layout.swiftBuildCalls.length}\n`,
        );
        return { exitCode: 0, stdout: 'Build complete!', stderr: '' };
      }
      layout.helperCommands.push([cmd, ...args].join(' '));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { bundleId: 'com.example.Finder', appName: 'Finder', pid: 4242 },
        }),
        stderr: '',
      };
    },
  };
});

const scratchRoot = await mkdtempForTest('agent-device-macos-helper-build-');
layout.home = path.join(scratchRoot, 'home');
layout.repoRoot = path.join(scratchRoot, 'repo');
layout.packageRoot = path.join(layout.repoRoot, 'apple', 'macos-helper');

// Imported after the mocks above and once the scratch home is known, because the install root is a
// module-level constant resolved against the home directory.
const { resolveFrontmostMacOsApp } = await import('./helper.ts');

const installedHelperPath = path.join(
  layout.home,
  '.agent-device',
  'macos-helper',
  'current',
  'agent-device-macos-helper',
);
const installedManifestPath = path.join(
  layout.home,
  '.agent-device',
  'macos-helper',
  'current',
  'manifest.json',
);

function sourcePath(...segments: string[]): string {
  return path.join(layout.packageRoot, ...segments);
}

/** A helper command is the freshness entry point: it cannot answer without fingerprinting the tree. */
async function askTheHelperForTheFrontmostApp(): Promise<void> {
  const frontmost = await resolveFrontmostMacOsApp();
  assert.equal(frontmost.bundleId, 'com.example.Finder');
  // The command runs the binary the freshness check just settled on, not a rebuild.
  assert.equal(layout.helperCommands.at(-1), `${installedHelperPath} app frontmost`);
}

async function installedFingerprint(): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(installedManifestPath, 'utf8')) as {
    fingerprint?: unknown;
  };
  assert.equal(typeof manifest.fingerprint, 'string');
  return manifest.fingerprint as string;
}

const savedHelperEnv = process.env.AGENT_DEVICE_MACOS_HELPER_BIN;

beforeEach(async () => {
  // A configured override path would short-circuit the freshness check the tests are about.
  delete process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
  layout.swiftBuildCalls.length = 0;
  layout.helperCommands.length = 0;
  await fs.rm(layout.home, { recursive: true, force: true });
  await fs.mkdir(sourcePath('Sources', 'Nested'), { recursive: true });
  await fs.mkdir(layout.home, { recursive: true });
  await Promise.all([
    fs.writeFile(sourcePath('Package.swift'), '// swift-tools-version: 6.2\n'),
    fs.writeFile(sourcePath('Sources', 'Main.swift'), 'let x = 1\n'),
    fs.writeFile(sourcePath('Sources', 'Nested', 'Traversal.swift'), 'let depth = 0\n'),
    fs.writeFile(sourcePath('Sources', 'notes.txt'), 'not build input\n'),
  ]);
});

afterEach(() => {
  if (savedHelperEnv === undefined) delete process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
  else process.env.AGENT_DEVICE_MACOS_HELPER_BIN = savedHelperEnv;
});

test('the macOS helper builds once per unchanged source tree and rebuilds when a source changes', async () => {
  await askTheHelperForTheFrontmostApp();

  // With no manifest to compare against, the first command builds, installs, and records what the
  // source tree looked like when it did.
  assert.deepEqual(layout.swiftBuildCalls, [
    `swift build -c release --package-path ${layout.packageRoot}`,
  ]);
  assert.equal((await fs.readFile(installedHelperPath)).toString(), '// helper build 1\n');
  assert.equal(((await fs.stat(installedHelperPath)).mode & 0o777).toString(8), '755');
  const firstFingerprint = await installedFingerprint();
  assert.match(firstFingerprint, /^[0-9a-f]{64}$/);

  // An unchanged tree must cost no rebuild, or every helper command would pay for `swift build`.
  await askTheHelperForTheFrontmostApp();
  assert.equal(layout.swiftBuildCalls.length, 1);
  assert.equal(await installedFingerprint(), firstFingerprint);

  // A source two directories deep is build input, so changing it has to cost a rebuild.
  await fs.appendFile(sourcePath('Sources', 'Nested', 'Traversal.swift'), 'let depth = 1\n');
  await askTheHelperForTheFrontmostApp();
  assert.equal(layout.swiftBuildCalls.length, 2);
  assert.notEqual(await installedFingerprint(), firstFingerprint);

  // `Package.swift` earns its place in the fingerprint by name, not by the `.swift` suffix.
  await fs.appendFile(sourcePath('Package.swift'), '// bumped a dependency\n');
  await askTheHelperForTheFrontmostApp();
  assert.equal(layout.swiftBuildCalls.length, 3);
});

test('the macOS helper fingerprint ignores build output, non-Swift files, and anything that is not a file', async () => {
  await askTheHelperForTheFrontmostApp();
  const warmedFingerprint = await installedFingerprint();

  // Stale compiler output, including a Swift file, under the ignored build directory.
  await fs.mkdir(sourcePath('.build', 'checkouts', 'Dependency', 'Sources'), { recursive: true });
  await fs.writeFile(
    sourcePath('.build', 'checkouts', 'Dependency', 'Sources', 'Generated.swift'),
    '// emitted\n',
  );
  // A file inside a source directory that the Swift compiler never compiles.
  await fs.writeFile(sourcePath('Sources', 'README.md'), '# notes\n');
  // A symlink in a source directory: neither a directory to descend into nor a file to hash.
  await fs.symlink(sourcePath('Sources', 'Main.swift'), sourcePath('Sources', 'Linked.swift'));

  await askTheHelperForTheFrontmostApp();

  assert.equal(layout.swiftBuildCalls.length, 1);
  assert.equal(await installedFingerprint(), warmedFingerprint);
});
