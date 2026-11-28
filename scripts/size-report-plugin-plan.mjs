import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

const MANIFEST = /^packages\/[^/]+\/package\.json$/;
const TEST_PATH = /(?:^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec|fixtures)\.[cm]?[jt]sx?$/;
const SHARED_BUILD_INPUT =
  /^(?:package\.json|pnpm-workspace\.yaml|\.npmrc|LICENSE|tsconfig[^/]*\.json|scripts\/lib\/bundled-license-notices\.ts)$/;
const ROOT_PLUGIN_INPUT = /^src\/sdk\//;
const BUILD_TOOLS = ['tsdown', 'typescript', '@typescript/native-preview', 'rollup-plugin-license'];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function workspaceAt(ref) {
  const files = git('ls-tree', '-r', '--name-only', '-z', ref, '--', 'packages').split('\0');
  return files
    .filter((file) => MANIFEST.test(file))
    .map((file) => ({
      directory: path.posix.dirname(file),
      manifest: JSON.parse(git('show', `${ref}:${file}`)),
    }));
}

function isPublishedPlugin({ manifest }) {
  return (
    manifest.private !== true && Boolean(manifest.agentDevicePlugin ?? manifest['agent-device'])
  );
}

function workspaceClosure(plugin, byName) {
  const seen = new Set();
  const pending = [plugin];
  while (pending.length > 0) {
    const pkg = pending.pop();
    if (seen.has(pkg.directory)) continue;
    seen.add(pkg.directory);
    const { dependencies, optionalDependencies, peerDependencies, devDependencies } = pkg.manifest;
    for (const [name, source] of Object.entries({
      ...dependencies,
      ...optionalDependencies,
      ...peerDependencies,
      ...devDependencies,
    })) {
      if (!source.startsWith('workspace:') || name === '@agent-device/test-kit') continue;
      const dependency = byName.get(name);
      if (dependency) pending.push(dependency);
    }
  }
  return seen;
}

function changedLockInputs(base, head) {
  const {
    importers: before = {},
    packages: beforePackages = {},
    snapshots: beforeSnapshots = {},
    ...baseSettings
  } = base;
  const {
    importers: after = {},
    packages: afterPackages = {},
    snapshots: afterSnapshots = {},
    ...headSettings
  } = head;
  const rootToolsChanged = BUILD_TOOLS.some(
    (name) =>
      !isDeepStrictEqual(before['.']?.devDependencies?.[name], after['.']?.devDependencies?.[name]),
  );
  // A lock entry can keep its identity while its transitive resolutions or integrity change.
  const shared =
    !isDeepStrictEqual(baseSettings, headSettings) ||
    rootToolsChanged ||
    changedExistingEntries(beforePackages, afterPackages) ||
    changedExistingEntries(beforeSnapshots, afterSnapshots);
  const directories = new Set(
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (directory) => directory !== '.' && !isDeepStrictEqual(before[directory], after[directory]),
    ),
  );
  return { shared, directories };
}

function changedExistingEntries(before, after) {
  return Object.keys(before).some(
    (key) => Object.hasOwn(after, key) && !isDeepStrictEqual(before[key], after[key]),
  );
}

function buildOwner(file) {
  if (file === 'scripts/lib/jpeg-decoder-only.ts') return 'maestro';
  return /^(?:build|bundler)\/([^/]+)(?:\/|$)/.exec(file)?.[1];
}

function affectedPlugins(workspace, files, lock, knownBuildOwners) {
  const byName = new Map(workspace.map((pkg) => [pkg.manifest.name, pkg]));
  const shared =
    lock.shared ||
    files.some((file) => {
      if (SHARED_BUILD_INPUT.test(file) || ROOT_PLUGIN_INPUT.test(file)) return true;
      const owner = buildOwner(file);
      return owner !== undefined && !knownBuildOwners.has(owner);
    });
  return workspace.filter(isPublishedPlugin).filter((pkg) => {
    if (shared) return true;
    const closure = workspaceClosure(pkg, byName);
    if ([...closure].some((directory) => lock.directories.has(directory))) return true;
    const owner = pkg.manifest.name.split('/').at(-1);
    const sourcePrefixes = [...closure].map((directory) => `${directory}/`);
    return files.some(
      (file) =>
        buildOwner(file) === owner || sourcePrefixes.some((prefix) => file.startsWith(prefix)),
    );
  });
}

function plan(base, head, files, lock) {
  const knownBuildOwners = new Set(
    [...base, ...head].filter(isPublishedPlugin).map((pkg) => pkg.manifest.name.split('/').at(-1)),
  );
  // The same Maestro build inputs can feed the core on branches where it is built in.
  knownBuildOwners.add('maestro');
  const productionFiles = files.filter((file) => !TEST_PATH.test(file));
  const changed = new Set(
    [
      ...affectedPlugins(base, productionFiles, lock, knownBuildOwners),
      ...affectedPlugins(head, productionFiles, lock, knownBuildOwners),
    ].map((pkg) => pkg.manifest.name),
  );
  const side = (workspace) =>
    workspace
      .filter(isPublishedPlugin)
      .filter((pkg) => changed.has(pkg.manifest.name))
      .map(({ directory, manifest }) => ({ directory, name: manifest.name }));
  return { base: side(base), head: side(head) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [base, head, output] = process.argv.slice(2);
  if (!base || !head || !output) {
    throw new Error('Usage: node scripts/size-report-plugin-plan.mjs <base> <head> <output-dir>');
  }
  const files = git('diff', '--name-only', '--no-renames', '-z', base, head, '--').split('\0');
  const lock = files.includes('pnpm-lock.yaml')
    ? changedLockInputs(
        parse(git('show', `${base}:pnpm-lock.yaml`)),
        parse(git('show', `${head}:pnpm-lock.yaml`)),
      )
    : { shared: false, directories: new Set() };
  const plugins = plan(workspaceAt(base), workspaceAt(head), files, lock);
  fs.mkdirSync(output, { recursive: true });
  for (const [side, entries] of Object.entries(plugins)) {
    fs.writeFileSync(path.join(output, `${side}.json`), JSON.stringify(entries));
    process.stdout.write(
      `Plugin sizes (${side}): ${entries.map((entry) => entry.name).join(', ') || 'none'}\n`,
    );
  }
}
