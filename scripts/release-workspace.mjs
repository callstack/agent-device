import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const [command, ...options] = process.argv.slice(2);
if (
  !['sync', 'check', 'pack', 'publish'].includes(command) ||
  options.some((option) => option !== '--stage')
) {
  throw new Error('Usage: node scripts/release-workspace.mjs <sync|check|pack|publish> [--stage]');
}
const packages = JSON.parse(
  execFileSync('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
  }),
).map((project) => {
  const manifestPath = path.join(project.path, 'package.json');
  return {
    directory: project.path,
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
});
const rootPackage = packages.find((pkg) => pkg.directory === root);
if (!rootPackage) throw new Error('The release workspace must include its root package.');
const version = rootPackage.manifest.version;
const publicPackages = packages.filter((pkg) => pkg.manifest.private !== true);

if (command === 'sync') {
  syncVersions();
} else {
  for (const pkg of publicPackages) {
    if (pkg.manifest.version !== version) {
      throw new Error(
        `${pkg.manifest.name}@${pkg.manifest.version} must match agent-device@${version}. Run npm version first.`,
      );
    }
  }
  if (command === 'pack') packWorkspacePackages();
  if (command === 'publish') publishWorkspacePackages();
}

function syncVersions() {
  for (const pkg of publicPackages) {
    if (pkg.manifest.version === version) continue;
    pkg.manifest.version = version;
    fs.writeFileSync(pkg.manifestPath, `${JSON.stringify(pkg.manifest, null, 2)}\n`);
  }
  if (options.includes('--stage')) {
    execFileSync('git', ['add', '--', ...publicPackages.map((pkg) => pkg.manifestPath)], {
      cwd: root,
      stdio: 'inherit',
    });
  }
}

function packWorkspacePackages() {
  const destination = path.join(root, '.tmp', 'release');
  fs.mkdirSync(destination, { recursive: true });
  for (const pkg of publicPackages) {
    const tarball = path.join(
      destination,
      `${pkg.manifest.name.replace('@', '').replace('/', '-')}-${version}.tgz`,
    );
    if (pkg.directory !== root) {
      execFileSync('pnpm', ['pack', '--out', tarball], { cwd: pkg.directory, stdio: 'inherit' });
    }
    const packed = JSON.parse(
      execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    checkPackedIdentity(packed, pkg.manifest.name);
    checkPublishedDependencies(packed);
  }
}

function checkPublishedDependencies(packed) {
  const unpublishableNames = new Set(
    packages.filter((pkg) => pkg.manifest.private === true).map((pkg) => pkg.manifest.name),
  );
  if (packed.agentDevicePlugin) unpublishableNames.add(rootPackage.manifest.name);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    checkDependencyField(field, packed[field] ?? {}, unpublishableNames);
  }
}

function checkDependencyField(field, dependencies, unpublishableNames) {
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (
      unpublishableNames.has(name) ||
      /^(workspace:|file:|link:|portal:|catalog:|git\+file:|[./])/.test(specifier)
    ) {
      throw new Error(`${field}.${name} is not a publishable runtime dependency.`);
    }
  }
}

function checkPackedIdentity(packed, name) {
  if (packed.name !== name || packed.version !== version || packed.private === true) {
    throw new Error('Packed package identity differs from the synchronized public package.');
  }
}

function publishWorkspacePackages() {
  if (process.env.npm_config_dry_run === 'true') {
    if (process.env.npm_lifecycle_event !== 'postpublish') {
      throw new Error(
        'Use npm publish --dry-run to preview a release; the retry command publishes.',
      );
    }
    return;
  }
  const args = [
    '--recursive',
    '--include-workspace-root',
    'publish',
    '--access',
    'public',
    '--no-git-checks',
    '--ignore-scripts',
  ];
  if (process.env.npm_lifecycle_event === 'postpublish') {
    args.push('--filter', `!${rootPackage.manifest.name}`);
  }
  execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/release-mark-dev.mjs'], { cwd: root, stdio: 'inherit' });
  execFileSync(
    'git',
    [
      'commit',
      '--only',
      '-m',
      `chore: mark ${version} as released`,
      '--',
      ...publicPackages.map((pkg) => pkg.manifestPath),
      path.join(root, 'server.json'),
    ],
    { cwd: root, stdio: 'inherit' },
  );
}
