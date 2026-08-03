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
 * dynamic import stays invisible to step 4, and a `require` computed at runtime stays invisible to
 * step 3.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { walkFiles } from './lib/walk-files.ts';

type PackedManifest = {
  dependencies?: Record<string, string>;
  exports: Record<string, unknown>;
  bin: Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
// `npm install` resolves `file:` tarballs through the real path, and macOS `/var` is a symlink to
// `/private/var`; resolving up front keeps the paths this script prints equal to the ones npm uses.
const workDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-device-package-'));
const consumerDir = path.join(workDir, 'consumer');
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** Stdout is captured for the callers that parse it; stderr passes through so failures are readable. */
function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function localBin(name: string): string {
  return path.join(repoRoot, 'node_modules', '.bin', name);
}

function step(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Packs with `--ignore-scripts` so the pack cannot re-enter `prepack` and recurse. */
function packTarball(): string {
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'src'))) {
    throw new Error('No dist/src build found. Run `pnpm build` first.');
  }
  const packed = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', workDir], repoRoot),
  ) as [{ filename: string }];
  return path.join(workDir, packed[0].filename);
}

function lintTarball(tarball: string): void {
  run(localBin('publint'), ['--strict', tarball], repoRoot);
  // This package is ESM-only (`type: module`, `engines.node >= 22.12`), so the `esm-only` profile is
  // the honest one: it keeps every ESM and bundler resolution failing, and drops the CJS-consumer and
  // pre-`exports` node10 rules that no supported consumer can hit.
  run(localBin('attw'), ['--profile', 'esm-only', tarball], repoRoot);
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

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!;
}

function moduleSpecifiers(file: string, source: string): string[] {
  const record = parseSync(file, source).module;
  return [
    ...record.staticImports.map((entry) => entry.moduleRequest.value),
    ...record.staticExports.flatMap((entry) =>
      entry.entries.flatMap((exported) =>
        exported.moduleRequest?.value ? [exported.moduleRequest.value] : [],
      ),
    ),
    ...record.dynamicImports.flatMap((entry) => {
      const raw = source.slice(entry.moduleRequest.start, entry.moduleRequest.end);
      const literal = /^(['"])([^'"]*)\1$/.exec(raw);
      return literal?.[2] ? [literal[2]] : [];
    }),
  ];
}

/**
 * Both directions matter. An import the manifest does not declare breaks the install; a declared
 * dependency nothing imports is an install every user pays for and no code reaches — how `pngjs`
 * stayed in `dependencies` after `tsdown.config.ts` started inlining it.
 */
function auditDependencyClosure(installedRoot: string, manifest: PackedManifest): void {
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const importedBy = new Map<string, string[]>();
  const undeclared: string[] = [];

  for (const file of walkFiles(installedRoot, (file) => /\.(?:m?js|d\.ts)$/.test(file))) {
    const relative = path.relative(installedRoot, file);
    for (const specifier of moduleSpecifiers(file, fs.readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || builtins.has(specifier))
        continue;
      const name = packageNameOf(specifier);
      if (!declared.has(name)) undeclared.push(`${specifier} in ${relative}`);
      importedBy.set(name, [...(importedBy.get(name) ?? []), relative]);
    }
  }

  const unused = [...declared].filter((name) => !importedBy.has(name));
  if (undeclared.length > 0 || unused.length > 0) {
    throw new Error(
      [
        'The published dependency closure does not match what the package imports.',
        ...(undeclared.length > 0
          ? [
              'Imported but not declared in "dependencies" (a published install cannot resolve these):',
              ...undeclared.map((entry) => `  - ${entry}`),
              'Declare the package, or add it to `deps.alwaysBundle` in tsdown.config.ts.',
            ]
          : []),
        ...(unused.length > 0
          ? [
              'Declared in "dependencies" but never imported (every user installs these for nothing):',
              ...unused.map((name) => `  - ${name}`),
              'Remove the dependency, or stop bundling it in tsdown.config.ts.',
            ]
          : []),
      ].join('\n'),
    );
  }
  step(`Verified the dependency closure: ${[...importedBy.keys()].sort().join(', ')}.`);
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
 * offline. `--state-dir` keeps the daemon they start out of the developer's `~/.agent-device`, and
 * `daemon stop` leaves nothing running behind the check.
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
  const manifest = JSON.parse(
    fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'),
  ) as PackedManifest;
  auditDependencyClosure(installedRoot, manifest);
  importEveryExport(manifest);
  smokeTestBin(installedRoot, manifest);
} catch (error) {
  process.stderr.write(`Package verification failed. Retained ${workDir} for inspection.\n`);
  throw error;
}
fs.rmSync(workDir, { recursive: true, force: true });
step('The package npm would publish is sound.');
