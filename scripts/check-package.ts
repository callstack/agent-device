/**
 * The publishing gate: packs the tarball npm would publish, then proves it sound from a clean
 * consumer install rather than from the workspace. Published 0.20.4 broke on `agent-device devices`
 * with an unresolvable `@agent-device/ad-script` import (#1577) because nothing between `pnpm build`
 * and `npm publish` ever resolved the package the way a user does — every check here is a check that
 * would have caught it.
 *
 * Checked, in order:
 *  1. `publint` — packaging metadata against the packed tarball (exports/bin/types conditions).
 *  2. `attw` — declaration resolution for the module systems this package supports.
 *  3. runtime dependency closure — every bare specifier the shipped files import is a Node builtin
 *     or a declared `dependencies` entry, and every declared entry is actually imported.
 *  4. every `exports` subpath imports, and the `bin` runs, from outside the workspace.
 *
 * Step 3 is the static half and step 4 the runtime half of the same question: nothing the package
 * imports may depend on workspace linking. Keep both — a specifier reachable only through a lazy
 * dynamic import stays invisible to step 4, and a specifier computed at runtime stays invisible to
 * step 3. Step 3 lives in scripts/lib/shipped-imports.ts, where fixture tests can prove it rejects
 * a malformed package; everything here needs a real pack and can only exercise the healthy path.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditDependencyClosure,
  type PackedManifest as PackedDependencies,
} from './lib/shipped-imports.ts';
import { assertInstalledSnapshotBridge } from './size-report-install.mjs';

type PackedManifest = PackedDependencies & {
  exports: Record<string, unknown>;
  bin: Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const packDestinationFlag = '--pack-destination';
const verifySnapshotBridgePreparation = process.argv.includes(
  '--verify-snapshot-bridge-preparation',
);
const suppliedPackDestination = process.argv
  .slice(2)
  .find((arg, index, args) => (args[index - 1] === packDestinationFlag ? arg : undefined));
if (process.argv.includes(packDestinationFlag) && !suppliedPackDestination) {
  throw new Error(`${packDestinationFlag} requires a destination directory.`);
}
// `npm install` resolves `file:` tarballs through the real path, and macOS `/var` is a symlink to
// `/private/var`; resolving up front keeps the paths this script prints equal to the ones npm uses.
const workDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-device-package-'));
const packDestination = suppliedPackDestination
  ? path.resolve(repoRoot, suppliedPackDestination)
  : workDir;
const consumerDir = path.join(workDir, 'consumer');

/** Stdout is captured for the callers that parse it; stderr passes through so failures are readable. */
function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * The two established packaging linters, run against the tarball rather than the working tree.
 * Invoked through their `node_modules/.bin` shims and not `pnpm exec`, because this gate also runs on
 * the minimum supported Node, which the repo's pinned pnpm refuses to start on.
 */
const TARBALL_LINTERS = [
  { dependency: 'publint', bin: 'publint', args: ['--strict'] },
  // The `esm-only` profile is the honest one for this package (`type: module`,
  // `engines.node >= 22.12`): it keeps every ESM and bundler resolution failing, and drops the
  // CJS-consumer and pre-`exports` node10 rules that no supported consumer can hit.
  { dependency: '@arethetypeswrong/cli', bin: 'attw', args: ['--profile', 'esm-only'] },
] as const;

function step(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Packs with `--ignore-scripts` so the pack cannot re-enter `prepack` and recurse. */
function packTarball(): string {
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'src'))) {
    throw new Error('No dist/src build found. Run `pnpm build` first.');
  }
  fs.mkdirSync(packDestination, { recursive: true });
  const packed = JSON.parse(
    run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDestination],
      repoRoot,
    ),
  ) as [{ filename: string }];
  return path.join(packDestination, packed[0].filename);
}

function lintTarball(tarball: string): void {
  for (const linter of TARBALL_LINTERS) {
    run(
      path.join(repoRoot, 'node_modules', '.bin', linter.bin),
      [...linter.args, tarball],
      repoRoot,
    );
  }
  step(`Linted the tarball with ${TARBALL_LINTERS.map((linter) => linter.bin).join(' and ')}.`);
}

/**
 * Installs the tarball into a project outside the workspace. `node_modules` here is built by npm
 * from the registry, so a workspace-only specifier has nothing to resolve against — exactly the
 * position a user installing from npm is in.
 */
function installIntoCleanConsumer(tarball: string): string {
  fs.mkdirSync(consumerDir);
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'agent-device-package-check', private: true, type: 'module' }, null, 2)}\n`,
  );
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumerDir);
  return path.join(consumerDir, 'node_modules', 'agent-device');
}

/** Imports every documented entry point in one process so a failure names the subpath that broke. */
function importEveryExport(manifest: PackedManifest): void {
  const specifiers = Object.keys(manifest.exports).map((subpath) =>
    path.posix.join('agent-device', subpath),
  );
  const probe = path.join(consumerDir, 'import-exports.mjs');
  fs.writeFileSync(
    probe,
    `const specifiers = ${JSON.stringify(specifiers)};
const failures = [];
for (const specifier of specifiers) {
  try {
    await import(specifier);
  } catch (error) {
    failures.push('  - ' + specifier + ': ' + error.message);
  }
}
if (failures.length > 0) {
  process.stderr.write('Published entry points failed to import:\\n' + failures.join('\\n') + '\\n');
  process.exit(1);
}
`,
  );
  run(process.execPath, [probe], consumerDir);
  step(`Imported all ${specifiers.length} published entry points from a clean install.`);
}

/**
 * `devices` and `doctor --remote` are the cheapest commands that load the daemon bundle and the
 * remote-config graph — the lazily imported halves of the CLI that no `--version` or `help` run
 * reaches, and where the 0.20.4 unresolved import actually surfaced. Every command is device-free and
 * offline. The subprocess environment disables the detached update notifier so the non-JSON
 * `daemon stop` probe cannot recreate files while the temporary consumer is being removed.
 * `--state-dir` keeps the daemon they start out of the developer's `~/.agent-device`, and `daemon
 * stop` leaves nothing running behind the check.
 */
function smokeTestBin(installedRoot: string, manifest: PackedManifest): void {
  const binPath = path.join(installedRoot, manifest.bin['agent-device']!);
  const stateDir = ['--state-dir', path.join(workDir, 'state')];
  const version = run(process.execPath, [binPath, '--version'], consumerDir).trim();
  run(process.execPath, [binPath, 'help'], consumerDir);
  try {
    for (const args of [
      ['devices', '--json'],
      ['doctor', '--remote', '--json'],
    ]) {
      run(process.execPath, [binPath, ...args, ...stateDir], consumerDir);
    }
  } finally {
    run(process.execPath, [binPath, 'daemon', 'stop', ...stateDir], consumerDir);
  }
  step(`Ran the published CLI ${version} on Node ${process.versions.node}.`);
}

step(`Packing and verifying agent-device in ${workDir}`);
try {
  const tarball = packTarball();
  lintTarball(tarball);
  const installedRoot = installIntoCleanConsumer(tarball);
  assertInstalledSnapshotBridge(installedRoot);
  if (verifySnapshotBridgePreparation) {
    if (process.platform !== 'darwin') {
      throw new Error('--verify-snapshot-bridge-preparation requires macOS and Xcode.');
    }
    run(
      'pnpm',
      [
        '--filter',
        '@agent-device/platform-apple',
        'run',
        'verify-installed-snapshot-bridge',
        installedRoot,
        path.join(workDir, 'snapshot-bridge-cache'),
      ],
      repoRoot,
    );
    step('Prepared the Simulator snapshot bridge from the clean-installed package.');
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'),
  ) as PackedManifest;
  const importedBy = auditDependencyClosure(installedRoot, manifest);
  step(`Verified the dependency closure: ${[...importedBy.keys()].sort().join(', ')}.`);
  importEveryExport(manifest);
  smokeTestBin(installedRoot, manifest);
} catch (error) {
  process.stderr.write(`Package verification failed. Retained ${workDir} for inspection.\n`);
  throw error;
}
fs.rmSync(workDir, { recursive: true, force: true });
step('The package npm would publish is sound.');
